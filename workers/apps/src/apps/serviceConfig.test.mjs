import { fileURLToPath } from "node:url";
import { testInstallation } from "../../../../tests/helpers/installation.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let modulePromise;
let secretsModulePromise;
let appAuthSyncModulePromise;

async function loadTsModule(entryPoint) {
  const outdir = await mkdtemp(join(tmpdir(), "apps-service-config-test-"));
  const outfile = join(outdir, `${entryPoint.replace(/[^a-z0-9]+/gi, "-")}.mjs`);
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL(entryPoint, import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function serviceModule() {
  modulePromise ??= loadTsModule("./service.ts");
  return modulePromise;
}

function secretsModule() {
  secretsModulePromise ??= loadTsModule("./secrets.ts");
  return secretsModulePromise;
}

function appAuthSyncModule() {
  appAuthSyncModulePromise ??= loadTsModule("./authSync.ts");
  return appAuthSyncModulePromise;
}

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database.prepare(sql));
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }
}

class D1StatementAdapter {
  constructor(statement, params = []) {
    this.params = params;
    this.statement = statement;
  }

  bind(...params) {
    return new D1StatementAdapter(this.statement, params);
  }

  async all() {
    return { results: this.statement.all(...this.params) };
  }

  async first() {
    return this.statement.get(...this.params) ?? null;
  }

  async run() {
    this.statement.run(...this.params);
    return { success: true };
  }
}

function createEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/apps/db/schema.sql", "utf8"));
  return { ...testInstallation,
    DEV_AUTH_BYPASS:"1",
    WORKSPACE_EMAIL_ROUTER_WORKER: "workspace-email-router-test",
    WORKSPACE_EMAIL_ROUTING_DOMAIN: "mail.example.test",
    APPS_BASE_DOMAIN: "example.invalid",
    PLATFORM_MCP_URL: "https://apps.example.invalid/mcp",
    APPS_DB: new D1Adapter(database),
    APPS_SECRET_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef"
  };
}

function seedAuthApp(env, app) {
  env.APPS_DB.database.prepare(`
    INSERT INTO apps_apps (
      id, org_id, org_slug, owner_user_id, collaborator_user_ids_json,
      name, code, slug, description, type, status, visibility,
      login_required, access_targets_json, data_service_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', 'draft', 'org', 1, '[]', ?, ?, ?)
  `).run(
    app.id,
    app.org_id || "org-1",
    app.org_slug || "workspace",
    app.owner_user_id || "owner-1",
    app.collaborator_user_ids_json || "[]",
    app.name,
    app.code,
    app.slug || app.code,
    app.description || "",
    app.data_service_id || `ds-${app.id}`,
    app.created_at || new Date().toISOString(),
    app.updated_at || new Date().toISOString()
  );
}

const principal = {
  email: "owner@example.invalid",
  orgId: "org-1",
  orgSlug: "workspace",
  scopes: ["apps:read", "apps:write"],
  sub: "user-1"
};

async function decryptWithKeyMaterial(keyMaterial, encrypted) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(encrypted.cipherIv, "base64") },
    key,
    Buffer.from(encrypted.cipherText, "base64")
  );
  return new TextDecoder().decode(plain);
}

describe("APPS app capability config", () => {
  it("creates a static application without a model service", async () => {
    const env = createEnv();
    delete env.LITELLM_URL;
    const { createAppFromInput } = await serviceModule();
    const result = await createAppFromInput({ name: "Static acceptance", type: "static_page", llmEnabled: false }, env, principal);
    assert.equal(result.app.manifest.llm.enabled, false);
    assert.equal(result.app.manifest.llm.gatewayUrl, "");
    assert.equal(result.provisioningJob.status, "queued");
    env.APPS_DB.database.close();
  });
  it("emails the creator without company recipients or office instructions by default", async () => {
    const env = createEnv();
    env.APPS_AUTH_SERVICE_TOKEN = "test-service-token";
    env.APPS_BASE_DOMAIN = "apps.example.com";
    const messages = [];
    env.AUTH_SERVICE = { async fetch(request) {
      assert.equal(new URL(request.url).pathname, "/v1/notifications/email");
      assert.equal(request.headers.get("Authorization"), "Bearer test-service-token");
      const message = await request.json();
      assert.ok(env.APPS_DB.database.prepare("SELECT id FROM apps_apps WHERE code = ?").get("email-created"));
      messages.push(message);
      return new Response("{}");
    } };
    const { createAppFromInput } = await serviceModule();
    const { app } = await createAppFromInput({ code: "email-created", name: "<Test & App>", description: "Internal reporting", type: "web" }, env, principal);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, principal.email);
    assert.equal(messages[0].cc, undefined);
    assert.equal(messages[0].subject, "[Matrix land] 应用创建成功 · <Test & App>");
    assert.ok(messages[0].text.includes(app.productionUrl));
    assert.doesNotMatch(messages[0].text, /example-org|办公室允许|尖沙咀/i);
    assert.ok(messages[0].html.includes(`应用域名：${new URL(app.productionUrl).hostname}`));
    assert.equal(messages[0].text.includes("业务用途："), false);
    assert.match(messages[0].html, /&lt;Test &amp; App&gt;/);
    assert.equal(messages[0].html.includes("<Test & App>"), false);
  });

  it("keeps app creation successful when notification delivery fails", async () => {
    const env = createEnv();
    env.AUTH_SERVICE_TOKEN = "test-service-token";
    env.AUTH_SERVICE = { async fetch() { return new Response("failed", { status: 502 }); } };
    const { createAppFromInput } = await serviceModule();
    const { app } = await createAppFromInput({ code: "email-failed", name: "Mail failure", type: "web" }, env, principal);
    assert.equal(app.appCode, "email-failed");
  });

  it("skips notification when the authenticated creator has no email", async () => {
    const env = createEnv();
    env.AUTH_SERVICE_TOKEN = "test-service-token";
    env.AUTH_SERVICE = { async fetch() { assert.fail("must not send without creator email"); } };
    const { createAppFromInput } = await serviceModule();
    const { app } = await createAppFromInput({ code: "no-email", name: "No email", type: "web" }, env, { ...principal, email: undefined });
    assert.equal(app.appCode, "no-email");
  });

  it("keeps company directory reads independent from App launch admission", async () => {
    const env = createEnv();
    env.AUTH_SERVICE_TOKEN = "service-token";
    env.AUTH_WORKER_URL = "https://auth.example.test";
    const { createAppFromInput, patchApp } = await serviceModule();
    const { app } = await createAppFromInput({
      code: "company-directory-app",
      loginRequired: true,
      name: "Company Directory App",
      type: "web",
      visibility: "private"
    }, env, principal);
    await env.APPS_DB
      .prepare("UPDATE apps_apps SET status = 'published' WHERE id = ?")
      .bind(app.id)
      .run();

    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response("{}", { status: 200 });
    };

    let updated;
    try {
      updated = await patchApp(new Request(`https://apps.local/apps/${app.id}`, {
        body: JSON.stringify({ directoryReadScope: "company" }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }), env, principal, app.id);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(updated.directoryReadScope, "company");
    assert.equal(calls.length, 1);
    const authBody = JSON.parse(calls[0].init.body);
    assert.equal(authBody.accessMode, "targeted");
    assert.deepEqual(authBody.accessTargets, []);
    assert.equal(authBody.directoryReadScope, "company");
  });

  it("requires Workspace Auth before enabling company directory reads", async () => {
    const env = createEnv();
    const { createAppFromInput } = await serviceModule();

    await assert.rejects(
      () => createAppFromInput({
        code: "public-company-directory",
        directoryReadScope: "company",
        loginRequired: false,
        name: "Public Company Directory",
        type: "web",
        visibility: "public"
      }, env, principal),
      (error) => error.status === 400 && error.code === "company_directory_scope_requires_workspace_auth"
    );
  });

  it("lets Web and Automation apps opt into App MCP with Agent Schema", async () => {
    const { createAppFromInput } = await serviceModule();

    for (const type of ["web", "automation"]) {
      const env = createEnv();
      const result = await createAppFromInput({
        agentMcpEnabled: true,
        code: `mcp-${type}`,
        name: `MCP ${type}`,
        type,
        visibility: "org"
      }, env, principal);

      assert.equal(result.app.agentMcpEnabled, true);
      assert.ok(result.app.resources.some((resource) => resource.type === "worker"));
      assert.ok(result.app.resources.some((resource) => resource.type === "schema_registry"));
      assert.equal(result.app.manifest.mcp.registered, false);
      assert.equal(result.app.manifest.mcp.schemaRequired, true);
      assert.match(result.app.manifest.cli.deploy.worker, /--notes-file RELEASE_NOTES\.md/);
      assert.doesNotMatch(result.app.manifest.cli.deploy.worker, /CHANGELOG\.md/);
    }
  });

  it("enables App MCP for an existing Web app and waits for a registered deployment", async () => {
    const env = createEnv();
    const { createAppFromInput, patchApp } = await serviceModule();
    const created = await createAppFromInput({
      code: "existing-web-mcp",
      name: "Existing Web MCP",
      type: "web",
      visibility: "org"
    }, env, principal);
    await env.APPS_DB.prepare("UPDATE apps_app_resources SET status = 'ready' WHERE app_id = ? AND type = 'worker'")
      .bind(created.app.id)
      .run();

    const enabled = await patchApp(new Request(`https://apps.local/apps/${created.app.id}`, {
      body: JSON.stringify({ agentMcpEnabled: true }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }), env, principal, created.app.id);

    assert.equal(enabled.type, "web");
    assert.equal(enabled.agentMcpEnabled, true);
    assert.equal(enabled.manifest.mcp.registered, false);
    assert.equal(enabled.resources.filter((resource) => resource.type === "schema_registry").length, 1);
    assert.equal(enabled.resources.find((resource) => resource.type === "schema_registry")?.status, "ready");

    const enabledAgain = await patchApp(new Request(`https://apps.local/apps/${created.app.id}`, {
      body: JSON.stringify({ agentMcpEnabled: true }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }), env, principal, created.app.id);
    assert.equal(enabledAgain.resources.filter((resource) => resource.type === "schema_registry").length, 1);

    const disabled = await patchApp(new Request(`https://apps.local/apps/${created.app.id}`, {
      body: JSON.stringify({ agentMcpEnabled: false }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }), env, principal, created.app.id);
    assert.equal(disabled.agentMcpEnabled, false);
    assert.equal(disabled.manifest.mcp.registered, false);
    assert.equal(disabled.resources.filter((resource) => resource.type === "schema_registry").length, 1);
  });

  it("requires a ready server runtime and keeps unsupported or required MCP types safe", async () => {
    const env = createEnv();
    const { createAppFromInput, patchApp } = await serviceModule();
    const web = await createAppFromInput({ code: "web-not-ready", name: "Web not ready", type: "web" }, env, principal);
    await assert.rejects(
      () => patchApp(new Request(`https://apps.local/apps/${web.app.id}`, {
        body: JSON.stringify({ agentMcpEnabled: true }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }), env, principal, web.app.id),
      (error) => error.status === 409 && error.code === "app_mcp_server_runtime_required"
    );

    const staticPage = await createAppFromInput({ code: "static-no-mcp", name: "Static no MCP", type: "static_page" }, env, principal);
    await assert.rejects(
      () => patchApp(new Request(`https://apps.local/apps/${staticPage.app.id}`, {
        body: JSON.stringify({ agentMcpEnabled: true }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }), env, principal, staticPage.app.id),
      (error) => error.status === 400 && error.code === "app_mcp_capability_not_supported"
    );

    const agent = await createAppFromInput({ code: "agent-required", name: "Agent required", type: "agent_app" }, env, principal);
    await assert.rejects(
      () => patchApp(new Request(`https://apps.local/apps/${agent.app.id}`, {
        body: JSON.stringify({ agentMcpEnabled: false }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }), env, principal, agent.app.id),
      (error) => error.status === 409 && error.code === "agent_app_mcp_required"
    );
  });

  it("allows a private static Pages App only when Workspace Auth is required", async () => {
    const env = createEnv();
    const { createAppFromInput } = await serviceModule();

    await assert.rejects(
      () => createAppFromInput({
        code: "private-static-missing-auth",
        name: "Private Static Missing Auth",
        type: "static_page",
        visibility: "private"
      }, env, principal),
      (error) => error.status === 400 && error.code === "static_page_private_auth_required"
    );

    const { app } = await createAppFromInput({
      code: "private-static-data-map",
      loginRequired: true,
      name: "Private Static Data Map",
      type: "static_page",
      visibility: "private"
    }, env, principal);

    assert.equal(app.type, "static_page");
    assert.equal(app.visibility, "private");
    assert.equal(app.loginRequired, true);
    assert.ok(app.resources.some((resource) => resource.type === "pages_project"));
  });

  it("permanently appends resources to existing apps without replacement or removal", async () => {
    const env = createEnv();
    env.CF_ACCOUNT_ID = "acct-1";
    env.CF_API_TOKEN = "cf-token";
    const { createAppFromInput, patchApp } = await serviceModule();
    const web = await createAppFromInput({
      code: "append-web-resource",
      name: "Append Web Resource",
      type: "web"
    }, env, principal);
    const originalFetch = globalThis.fetch;
    let bucketCreated = false;
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const method = (init.method || "GET").toUpperCase();
      calls.push({ method, pathname: url.pathname });
      if (method === "GET" && url.pathname.endsWith("/r2/buckets/apps-append-web-resource-r2")) {
        if (!bucketCreated) {
          return new Response(JSON.stringify({ success: false }), {
            headers: { "content-type": "application/json" },
            status: 404
          });
        }
        return Response.json({ result: { name: "apps-append-web-resource-r2" }, success: true });
      }
      if (method === "POST" && url.pathname.endsWith("/r2/buckets")) {
        bucketCreated = true;
        return Response.json({ result: { name: "apps-append-web-resource-r2" }, success: true });
      }
      throw new Error(`unexpected_cloudflare_call:${method}:${url.pathname}`);
    };

    const patchResources = (appId, body) => patchApp(new Request(`https://apps.local/apps/${appId}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }), env, principal, appId);

    try {
      const updated = await patchResources(web.app.id, { addResourceTypes: ["r2_bucket"] });
      const r2 = updated.resources.find((resource) => resource.type === "r2_bucket");
      assert.ok(r2);
      assert.equal(r2.status, "ready");
      assert.equal(r2.bindingName, "BUCKET");
      assert.equal(r2.resourceName, "apps-append-web-resource-r2");

      const updatedAgain = await patchResources(web.app.id, { addResourceTypes: ["r2_bucket"] });
      assert.equal(updatedAgain.resources.filter((resource) => resource.type === "r2_bucket").length, 1);
      assert.equal(calls.filter((call) => call.method === "POST").length, 1);

      await assert.rejects(
        () => patchResources(web.app.id, { removeResourceTypes: ["r2_bucket"] }),
        (error) => error.status === 409 && error.code === "app_resource_removal_not_supported"
      );
      await assert.rejects(
        () => patchResources(web.app.id, { resourceTypes: ["worker"] }),
        (error) => error.status === 400 && error.code === "app_resource_replacement_not_supported"
      );

      const staticPage = await createAppFromInput({
        code: "append-pages-resource",
        name: "Append Pages Resource",
        type: "static_page"
      }, env, principal);
      for (const unsupportedType of ["hyperdrive_config", "cron_trigger", "queue"]) {
        await assert.rejects(
          () => patchResources(staticPage.app.id, { addResourceTypes: [unsupportedType] }),
          (error) => error.status === 400 && error.code === "invalid_resource_selection"
        );
      }
      assert.equal(staticPage.app.resources.some((resource) => resource.type === "hyperdrive_config"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps canonical App codes globally unique across organizations", async () => {
    const env = createEnv();
    const { createAppFromInput } = await serviceModule();
    const first = await createAppFromInput({
      code: "shared-runtime",
      name: "First Runtime",
      type: "web",
      visibility: "org"
    }, env, principal);
    const second = await createAppFromInput({
      code: "shared-runtime",
      name: "Second Runtime",
      type: "web",
      visibility: "org"
    }, env, {
      ...principal,
      orgId: "org-2",
      orgSlug: "other-org",
      sub: "user-2"
    });

    assert.equal(first.app.appCode, "shared-runtime");
    assert.match(second.app.appCode, /^shared-runtime-[0-9a-f]{6}$/);
    assert.notEqual(second.app.productionUrl, first.app.productionUrl);
  });

  it("rejects unsupported app types at the API and database boundaries", async () => {
    const env = createEnv();
    const { createAppFromInput } = await serviceModule();
    await assert.rejects(
      () => createAppFromInput({ code: "unsupported-qa", name: "Unsupported QA", type: "obsolete_runtime" }, env, principal),
      (error) => error.status === 400 && error.code === "invalid_app_type"
    );
    const now = new Date().toISOString();
    await assert.rejects(() => env.APPS_DB.prepare(`
      INSERT INTO apps_apps (id, org_id, org_slug, owner_user_id, name, code, slug, type, status, visibility, data_service_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'obsolete_runtime', 'archived', 'private', ?, ?, ?)
    `).bind("app-unsupported", principal.orgId, principal.orgSlug, principal.sub, "Unsupported QA", "unsupported-qa", "unsupported-qa", "ds-unsupported", now, now).run());
  });
  it("keeps App type and code immutable while updating name and description", async () => {
    const env = createEnv();
    const { createAppFromInput, patchApp } = await serviceModule();
    const { app } = await createAppFromInput({
      code: "stable-app",
      description: "Original description",
      name: "Stable App",
      type: "web",
      visibility: "org"
    }, env, principal);

    await assert.rejects(
      () => patchApp(new Request(`https://apps.local/apps/${app.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "renamed-app" })
      }), env, principal, app.id),
      (error) => error.status === 409 && error.code === "apps_app_code_immutable"
    );

    await assert.rejects(
      () => patchApp(new Request(`https://apps.local/apps/${app.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "container" })
      }), env, principal, app.id),
      (error) => error.status === 409 && error.code === "apps_app_type_immutable"
    );

    const updated = await patchApp(new Request(`https://apps.local/apps/${app.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: app.appCode,
        description: "Updated description",
        name: "Updated App",
        type: app.type
      })
    }), env, principal, app.id);

    assert.equal(updated.appCode, "stable-app");
    assert.equal(updated.type, "web");
    assert.equal(updated.name, "Updated App");
    assert.equal(updated.description, "Updated description");

    const cleared = await patchApp(new Request(`https://apps.local/apps/${app.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "" })
    }), env, principal, app.id);
    assert.equal(cleared.description, "");
  });

  it("enables Email Sending as a native email binding resource and sender env vars", async () => {
    const env = createEnv();
    const { createAppFromInput, patchApp } = await serviceModule();
    const { app } = await createAppFromInput({
      code: "mail-app",
      loginRequired: true,
      name: "Mail App",
      type: "web",
      visibility: "org"
    }, env, principal);

    const updated = await patchApp(new Request("https://apps.local/apps/app-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emailSenderMailbox: "workbuddy",
        emailSendingEnabled: true
      })
    }), env, principal, app.id);

    const emailResource = updated.resources.find((resource) => resource.type === "email_sending");
    assert.ok(emailResource);
    assert.equal(emailResource.resourceName, "apps-mail-app-email");
    assert.equal(updated.manifest.email.sending.senderMailbox, "workbuddy@mail.example.test");

    assert.equal(updated.secrets.some((item) => item.name === "WORKSPACE_EMAIL_SEND_TOKEN"), false);

    const sender = await env.APPS_DB.prepare("SELECT value FROM apps_app_env_vars WHERE app_id = ? AND name = ?").bind(app.id, "WORKSPACE_EMAIL_FROM").first();
    const endpoint = await env.APPS_DB.prepare("SELECT value FROM apps_app_env_vars WHERE app_id = ? AND name = ?").bind(app.id, "WORKSPACE_EMAIL_SEND_ENDPOINT").first();
    const tokenName = await env.APPS_DB.prepare("SELECT value FROM apps_app_env_vars WHERE app_id = ? AND name = ?").bind(app.id, "WORKSPACE_EMAIL_SEND_TOKEN_NAME").first();
    assert.equal(sender.value, "workbuddy@mail.example.test");
    assert.equal(endpoint, null);
    assert.equal(tokenName, null);

    await patchApp(new Request("https://apps.local/apps/app-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emailSenderMailbox: "ops@mail.example.test",
        emailSendingEnabled: true
      })
    }), env, principal, app.id);
    const updatedSender = await env.APPS_DB.prepare("SELECT value FROM apps_app_env_vars WHERE app_id = ? AND name = ?").bind(app.id, "WORKSPACE_EMAIL_FROM").first();
    assert.equal(updatedSender.value, "ops@mail.example.test");
    const reread = await patchApp(new Request("https://apps.local/apps/app-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emailSenderMailbox: "ops@mail.example.test",
        emailSendingEnabled: true
      })
    }), env, principal, app.id);
    assert.equal(reread.manifest.email.sending.senderMailbox, "ops@mail.example.test");

    await assert.rejects(
      () => patchApp(new Request("https://apps.local/apps/app-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailSenderMailbox: "workbuddy@example.invalid",
          emailSendingEnabled: true
        })
      }), env, principal, app.id),
      (error) => error.status === 400 && error.code === "invalid_email_sender_mailbox"
    );

    const disabled = await patchApp(new Request("https://apps.local/apps/app-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emailSendingEnabled: false
      })
    }), env, principal, app.id);

    assert.equal(disabled.resources.some((resource) => resource.type === "email_sending"), false);
    assert.equal(disabled.secrets.some((item) => item.name === "WORKSPACE_EMAIL_SEND_TOKEN"), false);
  });

  it("updates a deployed Worker Email binding immediately when Email Sending changes", async () => {
    const env = createEnv();
    env.CF_ACCOUNT_ID = "acct-1";
    env.CF_API_TOKEN = "cf-token";
    const { createAppFromInput, patchApp } = await serviceModule();
    const { app } = await createAppFromInput({
      code: "runtime-mail",
      name: "Runtime Mail",
      type: "container"
    }, env, principal);
    await env.APPS_DB.prepare(`
      UPDATE apps_app_resources
      SET provider = 'cloudflare-workers', resource_id = resource_name, status = 'ready'
      WHERE app_id = ? AND type = 'worker'
    `).bind(app.id).run();

    const originalFetch = globalThis.fetch;
    const patches = [];
    let settingsBindings = [
      { id: "d1-1", name: "DB", type: "d1" },
      { name: "APP_SECRET", type: "secret_text" },
      { name: "EMAIL", type: "send_email" },
      { name: "WORKSPACE_EMAIL_FROM", text: "old@mail.example.test", type: "plain_text" }
    ];
    globalThis.fetch = async (_input, init = {}) => {
      const method = (init.method || "GET").toUpperCase();
      if (method === "GET") {
        return new Response(JSON.stringify({ result: { bindings: settingsBindings }, success: true }), {
          headers: { "content-type": "application/json" }
        });
      }
      assert.equal(method, "PATCH");
      assert.ok(init.body instanceof FormData);
      assert.equal(new Headers(init.headers).has("Content-Type"), false);
      const settings = init.body.get("settings");
      assert.equal(settings.type, "application/json");
      const body = JSON.parse(await settings.text());
      settingsBindings = body.bindings;
      patches.push(body);
      return new Response(JSON.stringify({ result: {}, success: true }), {
        headers: { "content-type": "application/json" }
      });
    };

    const patchEmail = (body) => patchApp(new Request(`https://apps.local/apps/${app.id}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }), env, principal, app.id);

    try {
      await patchEmail({ emailSenderMailbox: "runtime-mail", emailSendingEnabled: true });
      assert.deepEqual(patches[0].bindings.find((binding) => binding.name === "APP_SECRET"), {
        name: "APP_SECRET", type: "inherit"
      });
      assert.deepEqual(patches[0].bindings.find((binding) => binding.name === "EMAIL"), {
        allowed_sender_addresses: ["runtime-mail@mail.example.test"],
        name: "EMAIL",
        type: "send_email"
      });
      assert.deepEqual(patches[0].bindings.find((binding) => binding.name === "WORKSPACE_EMAIL_FROM"), {
        name: "WORKSPACE_EMAIL_FROM",
        text: "runtime-mail@mail.example.test",
        type: "plain_text"
      });

      await patchEmail({ emailSendingEnabled: false });
      assert.equal(patches[1].bindings.some((binding) => binding.name === "EMAIL"), false);
      assert.equal(patches[1].bindings.some((binding) => binding.name === "WORKSPACE_EMAIL_FROM"), false);
      assert.ok(patches[1].bindings.some((binding) => binding.name === "DB"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("enables Email Routing as a config-only inbound address", async () => {
    const env = createEnv();
    const { createAppFromInput, patchApp } = await serviceModule();
    const { app } = await createAppFromInput({
      code: "inbox-app",
      loginRequired: true,
      name: "Inbox App",
      type: "web",
      visibility: "org"
    }, env, principal);

    assert.equal(app.resources.some((resource) => resource.type === "email_routing"), false);

    const updated = await patchApp(new Request("https://apps.local/apps/app-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emailRoutingEnabled: true,
        emailRoutingPrefix: "workbuddy"
      })
    }), env, principal, app.id);

    const emailRoutingResource = updated.resources.find((resource) => resource.type === "email_routing");
    assert.ok(emailRoutingResource);
    assert.equal(emailRoutingResource.resourceName, "workbuddy@mail.example.test");
    assert.equal(emailRoutingResource.resourceId, "workbuddy");
    assert.equal(updated.manifest.email.routing.enabled, true);
    assert.equal(updated.manifest.email.routing.address, "workbuddy@mail.example.test");
    assert.equal(updated.manifest.email.routing.routerWorker, "workspace-email-router-test");

    const inboundAddress = await env.APPS_DB.prepare("SELECT value FROM apps_app_env_vars WHERE app_id = ? AND name = ?").bind(app.id, "WORKSPACE_EMAIL_INBOUND_ADDRESS").first();
    const routerWorker = await env.APPS_DB.prepare("SELECT value FROM apps_app_env_vars WHERE app_id = ? AND name = ?").bind(app.id, "WORKSPACE_EMAIL_ROUTER_WORKER").first();
    assert.equal(inboundAddress.value, "workbuddy@mail.example.test");
    assert.equal(routerWorker.value, "workspace-email-router-test");

    const disabled = await patchApp(new Request("https://apps.local/apps/app-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emailRoutingEnabled: false
      })
    }), env, principal, app.id);

    assert.equal(disabled.resources.some((resource) => resource.type === "email_routing"), false);
    assert.equal(disabled.manifest.email.routing.enabled, false);
  });

  it("updates app access scope after creation", async () => {
    const env = createEnv();
    env.AUTH_SERVICE_TOKEN = "service-token";
    env.AUTH_WORKER_URL = "https://auth.example.test";
    const { createAppFromInput, updateVisibility } = await serviceModule();
    const { app } = await createAppFromInput({
      accessMode: "company",
      accessTargets: [],
      code: "access-app",
      loginRequired: true,
      name: "Access App",
      type: "web",
      visibility: "org"
    }, env, principal);
    await env.APPS_DB
      .prepare("UPDATE apps_apps SET status = 'published' WHERE id = ?")
      .bind(app.id)
      .run();
    const originalFetch = globalThis.fetch;
    let authRequest;
    globalThis.fetch = async (input, init) => {
      authRequest = { input, init };
      return new Response("{}", { status: 201 });
    };

    let updated;
    try {
      updated = await updateVisibility(new Request("https://apps.local/apps/app-1/visibility", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-visibility-1"
        },
        body: JSON.stringify({
          accessTargets: ["department:wealth", "user:user-2"],
          loginRequired: true,
          visibility: "team"
        })
      }), env, principal, app.id);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(updated.visibility, "team");
    assert.equal(updated.loginRequired, true);
    assert.deepEqual(updated.accessTargets, ["department:wealth", "user:user-2"]);
    assert.equal(authRequest.input, "https://auth.example.test/v1/admin/apps");
    assert.equal(authRequest.init.headers["x-request-id"], "req-visibility-1");
  });

  it("does not let a visibility update enable Auth without a security-checked redeployment", async () => {
    const env = createEnv();
    env.AUTH_SERVICE_TOKEN = "stale-token";
    env.AUTH_WORKER_URL = "https://auth.example.test";
    const { createAppFromInput, updateVisibility } = await serviceModule();
    const { app } = await createAppFromInput({
      accessTargets: [],
      code: "published-access-app",
      loginRequired: false,
      name: "Published Access App",
      type: "web",
      visibility: "public"
    }, env, principal);
    await env.APPS_DB
      .prepare("UPDATE apps_apps SET status = 'published' WHERE id = ?")
      .bind(app.id)
      .run();
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 201 });
    };

    try {
      await assert.rejects(
        () => updateVisibility(new Request("https://apps.local/apps/app-1/visibility", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accessTargets: [],
            loginRequired: true,
            visibility: "org"
          })
        }), env, principal, app.id),
        (error) => error.status === 409 && error.code === "auth_policy_change_requires_redeployment"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const row = await env.APPS_DB
      .prepare("SELECT visibility, login_required, access_targets_json FROM apps_apps WHERE id = ?")
      .bind(app.id)
      .first();
    assert.equal(row.visibility, "public");
    assert.equal(row.login_required, 0);
    assert.deepEqual(JSON.parse(row.access_targets_json), []);
    assert.equal(fetchCalls, 0);
  });

  it("retries transient Auth failures once and preserves the request ID", async () => {
    const { syncAppsAppAuthClient } = await appAuthSyncModule();
    const env = createEnv();
    Object.assign(env, {
      APPS_AUTH_SERVICE_TOKEN: "apps-service-token",
      AUTH_WORKER_URL: "https://auth.example.test",
      APPS_BASE_DOMAIN: "example.invalid"
    });
    const app = {
      id: "app-retry-auth",
      owner_user_id: "owner-1",
      org_id: "org-1",
      collaborator_user_ids_json: "[]",
      name: "Retry Auth App",
      code: "retry-shared-app",
      slug: "retry-shared-app",
      type: "web",
      access_targets_json: "[]"
    };
    seedAuthApp(env, app);
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (_input, init) => {
      calls.push(init);
      return new Response("{}", { status: calls.length === 1 ? 503 : 201 });
    };

    try {
      await syncAppsAppAuthClient(env, app, {
        accessTargets: [],
        loginRequired: true,
        requestId: "req-retry-1",
        visibility: "org"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.Authorization, "Bearer apps-service-token");
    assert.equal(calls[0].headers["x-request-id"], "req-retry-1");
    assert.equal(calls[1].headers["x-request-id"], "req-retry-1");
  });

  it("bounds a stalled Auth sync with a stable timeout error", async () => {
    const { syncAppsAppAuthClient } = await appAuthSyncModule();
    const env = createEnv();
    Object.assign(env, {
      AUTH_APP_SYNC_TIMEOUT_MS: "20",
      AUTH_SERVICE_TOKEN: "service-token",
      AUTH_WORKER_URL: "https://auth.example.test",
      APPS_BASE_DOMAIN: "example.invalid"
    });
    const app = {
      id: "app-timeout-auth",
      org_id: "org-1",
      owner_user_id: "owner-1",
      collaborator_user_ids_json: "[]",
      name: "Timeout Auth App",
      code: "timeout-shared-app",
      slug: "timeout-shared-app",
      type: "web",
      access_targets_json: "[]"
    };
    seedAuthApp(env, app);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

    try {
      await assert.rejects(
        () => syncAppsAppAuthClient(env, app, {
          accessTargets: [],
          loginRequired: true,
          requestId: "req-timeout-1",
          visibility: "org"
        }),
        (error) => error.status === 504 && error.code === "auth_app_sync_timeout"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("auto-provisions managed Auth secrets when Workbuddy is migrated", async () => {
    const { syncAppsAppAuthClient } = await appAuthSyncModule();
    const { createAppFromInput } = await serviceModule();
    const env = createEnv();
    env.AUTH_SERVICE_TOKEN = "service-token";
    env.AUTH_WORKER_URL = "https://auth.example.test";
    env.APPS_BASE_DOMAIN = "example.invalid";
    const created = await createAppFromInput({
      code: "workbuddy-request",
      loginRequired: true,
      name: "Workbuddy Request",
      type: "web",
      visibility: "org"
    }, env, principal);
    const app = await env.APPS_DB
      .prepare("SELECT * FROM apps_apps WHERE id = ?")
      .bind(created.app.id)
      .first();

    const originalFetch = globalThis.fetch;
    let body;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(init.body);
      return new Response("{}", { status: 201 });
    };
    try {
      await syncAppsAppAuthClient(env, app, {
        loginRequired: true,
        visibility: "org"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.match(body.appSecret, /^[0-9a-f]{64}$/);
    assert.equal(body.appSecretName, "WORKSPACE_AUTH_APP_SECRET");
    const secrets = await env.APPS_DB
      .prepare("SELECT name FROM apps_app_secrets WHERE app_id = ? ORDER BY name")
      .bind(app.id)
      .all();
    assert.deepEqual(secrets.results.map((secret) => secret.name), [
      "WORKSPACE_APP_SESSION_SECRET",
      "WORKSPACE_AUTH_APP_SECRET"
    ]);
  });

  it("auto-provisions independent confidential client and App session secrets for a generic authenticated App", async () => {
    const env = createEnv();
    env.AUTH_SERVICE_TOKEN = "service-token";
    env.AUTH_WORKER_URL = "https://auth.example.test";
    env.APPS_BASE_DOMAIN = "example.invalid";
    const { createAppFromInput } = await serviceModule();
    const { syncAppsAppAuthClient } = await appAuthSyncModule();
    const { app } = await createAppFromInput({
      code: "confidential-app",
      loginRequired: true,
      name: "Confidential App",
      type: "web",
      visibility: "org"
    }, env, principal);
    const row = await env.APPS_DB.prepare("SELECT * FROM apps_apps WHERE id = ?").bind(app.id).first();
    const originalFetch = globalThis.fetch;
    let registration;
    globalThis.fetch = async (_input, init) => {
      registration = JSON.parse(init.body);
      return new Response("{}", { status: 201 });
    };

    try {
      await syncAppsAppAuthClient(env, row, {
        loginRequired: true,
        visibility: "org"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(registration.appSecretName, "WORKSPACE_AUTH_APP_SECRET");
    assert.match(registration.appSecret, /^[0-9a-f]{64}$/);
    assert.deepEqual(registration.callbackUrls, [
      "https://confidential-app.example.invalid/auth/workspace/callback"
    ]);
    const secrets = await env.APPS_DB
      .prepare("SELECT name, cipher_text AS cipherText, cipher_iv AS cipherIv FROM apps_app_secrets WHERE app_id = ? AND name IN (?, ?) ORDER BY name")
      .bind(app.id, "WORKSPACE_AUTH_APP_SECRET", "WORKSPACE_APP_SESSION_SECRET")
      .all();
    assert.deepEqual(secrets.results.map((secret) => secret.name), [
      "WORKSPACE_APP_SESSION_SECRET",
      "WORKSPACE_AUTH_APP_SECRET"
    ]);
    const decrypted = await Promise.all(secrets.results.map((secret) => decryptWithKeyMaterial(
      env.APPS_SECRET_ENCRYPTION_KEY,
      secret
    )));
    assert.equal(decrypted.every((secret) => /^[0-9a-f]{64}$/.test(secret)), true);
    assert.equal(decrypted.includes(registration.appSecret), true);
  });

  it("grants targeted App launch access to every collaborator without changing public access mode", async () => {
    const { syncAppsAppAuthClient } = await appAuthSyncModule();
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response("{}", { status: 200 });
    };

    const app = {
      id: "app-shared-auth",
      org_id: "org-1",
      org_slug: "workspace",
      owner_user_id: "owner-1",
      collaborator_user_ids_json: JSON.stringify(["coauthor-1", "coauthor-2"]),
      name: "Shared Auth App",
      code: "shared-app",
      slug: "shared-app",
      description: "",
      type: "web",
      status: "published",
      visibility: "team",
      login_required: 1,
      access_targets_json: JSON.stringify(["department:wealth", "user:coauthor-2"]),
      data_service_id: "data-shared-auth",
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z"
    };
    const env = createEnv();
    Object.assign(env, {
      AUTH_SERVICE_TOKEN: "service-token",
      AUTH_WORKER_URL: "https://auth.example.test",
      APPS_BASE_DOMAIN: "example.invalid",
      PLATFORM_MCP_URL: "https://apps.example.invalid/mcp"
    });
    seedAuthApp(env, app);
    seedAuthApp(env, { ...app, id: "app-public-shared", code: "public-shared-app", slug: "public-shared-app" });

    try {
      await syncAppsAppAuthClient(env, app, {
        accessTargets: ["department:wealth", "user:coauthor-2"],
        loginRequired: true,
        visibility: "team"
      });
      await syncAppsAppAuthClient(env, {
        ...app,
        id: "app-public-shared",
        code: "public-shared-app",
        slug: "public-shared-app",
        visibility: "org",
        access_targets_json: "[]"
      }, {
        accessTargets: [],
        loginRequired: true,
        visibility: "org"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 2);
    assert.equal(calls[0].input, "https://auth.example.test/v1/admin/apps");
    const targetedBody = JSON.parse(calls[0].init.body);
    assert.equal(targetedBody.accessMode, "targeted");
    assert.deepEqual(targetedBody.accessTargets, [
      "user:coauthor-1",
      "user:coauthor-2",
      "department:wealth"
    ]);
    assert.deepEqual(targetedBody.collaboratorUserIds, ["coauthor-1", "coauthor-2"]);
    assert.equal(targetedBody.directoryReadScope, "app");
    assert.equal(targetedBody.systemRolePolicyVersion, app.updated_at);
    const publicBody = JSON.parse(calls[1].init.body);
    assert.equal(publicBody.accessMode, "public");
    assert.deepEqual(publicBody.accessTargets, ["user:coauthor-1", "user:coauthor-2"]);
  });

  it("resyncs a published App Auth policy as soon as collaborators change", async () => {
    const env = createEnv();
    env.AUTH_SERVICE_TOKEN = "service-token";
    env.AUTH_WORKER_URL = "https://auth.example.test";
    const { createAppFromInput, updateAppCollaborators } = await serviceModule();
    const { app } = await createAppFromInput({
      accessTargets: ["department:wealth"],
      code: "published-shared-app",
      loginRequired: true,
      name: "Published Shared App",
      type: "web",
      visibility: "team"
    }, env, principal);
    await env.APPS_DB
      .prepare("UPDATE apps_apps SET status = 'published' WHERE id = ?")
      .bind(app.id)
      .run();

    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response("{}", { status: 200 });
    };

    let updated;
    try {
      updated = await updateAppCollaborators(new Request("https://apps.local/apps/app-1/collaborators", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ collaboratorUserIds: ["coauthor-1"] })
      }), env, principal, app.id);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(updated.collaboratorUserIds, ["coauthor-1"]);
    assert.equal(calls.length, 1);
    const authBody = JSON.parse(calls[0].init.body);
    assert.equal(authBody.accessMode, "targeted");
    assert.deepEqual(authBody.accessTargets, ["user:coauthor-1", "department:wealth"]);
  });

  it("keeps a ready draft App restricted to its owner and collaborators", async () => {
    const env = createEnv();
    env.AUTH_SERVICE_TOKEN = "service-token";
    env.AUTH_WORKER_URL = "https://auth.example.test";
    const { createAppFromInput, updateAppCollaborators } = await serviceModule();
    const { app } = await createAppFromInput({
      accessTargets: ["department:wealth"],
      code: "draft-shared-app",
      loginRequired: true,
      name: "Draft Shared App",
      type: "web",
      visibility: "org"
    }, env, principal);
    await env.APPS_DB.prepare(`
      INSERT INTO apps_deployments (id, app_id, environment, version, status, url, created_by, created_at)
      VALUES ('dep-draft-ready', ?, 'production', 'v1', 'ready', 'https://draft-shared-app.example.invalid', ?, CURRENT_TIMESTAMP)
    `).bind(app.id, principal.sub).run();

    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response("{}", { status: 200 });
    };

    try {
      await updateAppCollaborators(new Request("https://apps.local/apps/app-1/collaborators", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ collaboratorUserIds: ["coauthor-1"] })
      }), env, principal, app.id);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 1);
    const authBody = JSON.parse(calls[0].init.body);
    assert.equal(authBody.status, "draft");
    assert.equal(authBody.sdkStatus, "connected");
    assert.equal(authBody.accessMode, "targeted");
    assert.deepEqual(authBody.accessTargets, ["user:coauthor-1"]);
    assert.equal(authBody.publisherUserId, principal.sub);
  });

  it("deletes manually configured Secret values", async () => {
    const env = createEnv();
    const { createAppFromInput } = await serviceModule();
    const { configureAppSecretValue, deleteAppSecretValue } = await secretsModule();
    const { app } = await createAppFromInput({
      code: "secret-app",
      loginRequired: true,
      name: "Secret App",
      type: "web",
      visibility: "org"
    }, env, principal);

    const configured = await configureAppSecretValue(new Request("https://apps.local/apps/app-1/secrets/value", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: "Market data key",
        environment: "production",
        name: "MARKET_DATA_API_KEY",
        required: true,
        value: "secret-value"
      })
    }), env, principal, app.id);

    assert.ok(configured.secrets.some((secret) => secret.name === "MARKET_DATA_API_KEY" && secret.status === "configured"));

    const deleted = await deleteAppSecretValue(new Request("https://apps.local/apps/app-1/secrets/value", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environment: "production",
        name: "MARKET_DATA_API_KEY"
      })
    }), env, principal, app.id);

    assert.equal(deleted.secrets.some((secret) => secret.name === "MARKET_DATA_API_KEY"), false);

    const audit = await env.APPS_DB.prepare("SELECT action FROM apps_audit_logs WHERE action = ? LIMIT 1").bind("deleted app secret").first();
    assert.equal(audit.action, "deleted app secret");
  });

  it("deletes an app only after matching App Code confirmation", async () => {
    const env = createEnv();
    const deletedKeys = [];
    env.APPS_ARTIFACTS = {
      async delete(key) {
        deletedKeys.push(...(Array.isArray(key) ? key : [key]));
      }
    };
    const { createAppFromInput, deleteApp } = await serviceModule();
    const { app } = await createAppFromInput({
      code: "delete-me",
      loginRequired: true,
      name: "Delete Me",
      type: "web",
      visibility: "org"
    }, env, principal);

    await env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_app_source_versions (
          id, app_id, environment, version, deployment_id, artifact_key, artifact_sha256,
          entrypoint, file_count, size_bytes, created_by, created_at
        )
        VALUES (?, ?, 'production', ?, NULL, ?, ?, 'index.html', 1, 10, ?, ?)
        `
      )
      .bind("src_1", app.id, "1.0.0", "apps/apps/delete-me/source.zip", "sha", principal.sub, "2026-07-02T00:00:00.000Z")
      .run();

    await assert.rejects(
      () => deleteApp(new Request("https://apps.local/apps/app-1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appCode: "wrong-code" })
      }), env, principal, app.id),
      (error) => error.status === 400 && error.code === "delete_confirmation_mismatch"
    );

    const result = await deleteApp(new Request("https://apps.local/apps/app-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appCode: "delete-me" })
    }), env, principal, app.id);

    assert.equal(result.deleted, true);
    assert.deepEqual(deletedKeys, ["apps/apps/delete-me/source.zip"]);
    assert.equal(await env.APPS_DB.prepare("SELECT id FROM apps_apps WHERE id = ?").bind(app.id).first(), null);
    assert.equal(await env.APPS_DB.prepare("SELECT id FROM apps_app_source_versions WHERE app_id = ?").bind(app.id).first(), null);

    const audit = await env.APPS_DB.prepare("SELECT action FROM apps_audit_logs WHERE action = ? LIMIT 1").bind("deleted app").first();
    assert.equal(audit.action, "deleted app");
  });

  it("keeps a failed external cleanup retryable in archived state", async () => {
    const env = createEnv();
    env.CF_ACCOUNT_ID = "acct-1";
    env.CF_API_TOKEN = "cf-token";
    const { createAppFromInput, deleteApp } = await serviceModule();
    const { app } = await createAppFromInput({
      code: "retry-delete",
      name: "Retry Delete",
      type: "container"
    }, env, principal);
    await env.APPS_DB.prepare(`
      UPDATE apps_app_resources
      SET provider = 'cloudflare-workers', resource_id = resource_name, status = 'ready'
      WHERE app_id = ? AND type = 'worker'
    `).bind(app.id).run();

    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({
          errors: [{ code: 1000, message: "temporary failure" }],
          success: false
        }), { headers: { "content-type": "application/json" }, status: 500 });
      }
      return new Response(JSON.stringify({ result: {}, success: true }), {
        headers: { "content-type": "application/json" }
      });
    };

    const request = () => new Request(`https://apps.local/apps/${app.id}`, {
      body: JSON.stringify({ appCode: "retry-delete" }),
      headers: { "content-type": "application/json" },
      method: "DELETE"
    });

    try {
      await assert.rejects(
        () => deleteApp(request(), env, principal, app.id),
        (error) => error.status === 500 && error.code === "cloudflare_api_500"
      );
      const failedApp = await env.APPS_DB.prepare("SELECT status FROM apps_apps WHERE id = ?").bind(app.id).first();
      assert.equal(failedApp.status, "archived");
      const failure = await env.APPS_DB.prepare("SELECT metadata_json FROM apps_audit_logs WHERE action = ? AND target_id = ?").bind("failed app deletion", app.id).first();
      const failureMetadata = JSON.parse(failure.metadata_json);
      assert.equal(failureMetadata.cleanupStage, "external_resources");
      assert.equal(failureMetadata.errorCode, "cloudflare_api_500");
      assert.equal(failureMetadata.details.cloudflare.method, "DELETE");
      assert.ok(!failure.metadata_json.includes("cf-token"));

      const result = await deleteApp(request(), env, principal, app.id);
      assert.equal(result.deleted, true);
      assert.equal(attempts, 2);
      assert.equal(await env.APPS_DB.prepare("SELECT id FROM apps_apps WHERE id = ?").bind(app.id).first(), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

it('provisions app-scoped SDK access while preserving published native email compatibility',async()=>{
 const env=createEnv();const calls=[];
 env.WORKSPACE_MAIL_SECRET='workspace-mail-test-signing-secret-over-32-characters';
 env.WORKSPACE_MAIL={async fetch(request){const body=await request.json();calls.push(body);assert.match(body.token,/^fmail_[a-f0-9]{64}$/);return Response.json({status:'ready'});}};
 const {createAppFromInput,patchApp}=await serviceModule();
 for(const legacy of [false,true]) {
  const {app}=await createAppFromInput({code:legacy?'legacy-mail-sdk':'new-mail-sdk',name:'SDK mail',type:'container'},env,principal);
  if(legacy)await env.APPS_DB.prepare("UPDATE apps_apps SET status='published' WHERE id=?").bind(app.id).run();
  await patchApp(new Request(`https://apps.local/apps/${app.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({emailSendingEnabled:true,emailSenderMailbox:legacy?'legacy-sdk':'new-sdk'})}),env,principal,app.id);
  const token=await env.APPS_DB.prepare("SELECT cipher_text,status FROM apps_app_secrets WHERE app_id=? AND name='WORKSPACE_MAIL_TOKEN'").bind(app.id).first();assert.equal(token.status,'configured');assert.ok(!token.cipher_text.includes('fmail_'));
  const endpoint=await env.APPS_DB.prepare("SELECT value FROM apps_app_env_vars WHERE app_id=? AND name='WORKSPACE_MAIL_ENDPOINT'").bind(app.id).first();assert.equal(endpoint.value,'https://mail-api.example.invalid');
  const compatibility=await env.APPS_DB.prepare("SELECT value FROM apps_app_env_vars WHERE app_id=? AND name='WORKSPACE_MAIL_LEGACY_NATIVE_EMAIL'").bind(app.id).first();assert.equal(compatibility?.value,legacy?'1':undefined);
 }
 assert.equal(calls.length,2);assert.equal(calls[0].send,true);assert.equal(calls[0].receive,false);assert.notEqual(calls[0].token,calls[1].token);
});


describe('unified application mailbox',()=>{
 it('creates one custom address for both directions, exposes Trigger settings and disables both together',async()=>{
  const {createAppFromInput,patchApp}=await serviceModule();const env=createEnv();
  const {app}=await createAppFromInput({name:'Unified mail app',code:'unified-mail',type:'web',emailEnabled:true,emailPrefix:'custom-unified',emailTriggerEnabled:true},env,principal);
  assert.equal(app.manifest.email.sending.senderMailbox,'custom-unified@mail.example.test');assert.equal(app.manifest.email.routing.address,'custom-unified@mail.example.test');assert.equal(app.manifest.email.routing.triggerEnabled,true);
  assert.equal(app.resources.filter(r=>r.type==='email_sending'||r.type==='email_routing').length,2);
  await assert.rejects(createAppFromInput({name:'Conflict mail',code:'conflict-mail',emailEnabled:true,emailPrefix:'custom-unified'},env,principal),/address_taken/);
  const disabled=await patchApp(new Request('https://apps.local/apps/'+app.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({emailEnabled:false})}),env,principal,app.id);
  assert.equal(disabled.manifest.email.sending.enabled,false);assert.equal(disabled.manifest.email.routing.enabled,false);assert.equal(disabled.manifest.email.routing.triggerEnabled,false);
  await assert.rejects(patchApp(new Request('https://apps.local/apps/'+app.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({emailTriggerEnabled:true})}),env,principal,app.id),/requires_mailbox/);
 });
 it('signs callbacks for the canonical app only and requires durable acknowledgement',async()=>{
  const wrangler = readFileSync(new URL('../../../../packages/installer/src/render.mjs', import.meta.url), 'utf8');
  assert.match(wrangler, /global_fetch_strictly_public/);
  const {createAppFromInput}=await serviceModule();const env=createEnv();const {app}=await createAppFromInput({name:'Callback mail app',code:'callback-mail',emailEnabled:true,emailPrefix:'callback-mail',emailTriggerEnabled:true},env,principal);
  env.APPS_DB.database.prepare("UPDATE apps_apps SET status='published' WHERE id=?").run(app.id);
  const {encryptSecretValue}=await loadTsModule('../core/auth.ts');const token='fmail_'+'a'.repeat(64);const encrypted=await encryptSecretValue(env,token);const now=new Date().toISOString();
  env.APPS_DB.database.prepare("INSERT INTO apps_app_secrets(id,app_id,org_id,name,environment,description,required,status,cipher_text,cipher_iv,algorithm,declared_by,created_at,updated_at) VALUES('mail-secret',?,?,'WORKSPACE_MAIL_TOKEN','production','Mail',1,'configured',?,?,?,?,?,?)").run(app.id,principal.orgId,encrypted.cipherText,encrypted.cipherIv,encrypted.algorithm,principal.sub,now,now);
  const {deliverAppMailEvent}=await loadTsModule('./mailTrigger.ts');const {verifyWorkspaceMailEvent,acknowledgeWorkspaceMailEvent}=await import('../../../../sdk/mail/events.ts');
  const authority={appId:app.id,orgId:principal.orgId,userId:principal.sub,scopes:['mail:app-event']};const event={id:'mail_callback',messageId:'mail_callback',type:'workspace.mail.received',appId:app.id,mailbox:'callback-mail@mail.example.test',receivedAt:now};
  const original=globalThis.fetch;let acknowledge=true;let signed;
  globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://callback-mail.example.invalid/_workspace/mail/received');signed=new Request(url,init);const verified=await verifyWorkspaceMailEvent(signed.clone(),{token,appId:app.id});assert.deepEqual(verified,event);return acknowledge?acknowledgeWorkspaceMailEvent(verified):new Response('login page');};
  try{await deliverAppMailEvent(env,authority,event);acknowledge=false;await assert.rejects(deliverAppMailEvent(env,authority,event),/not_acknowledged/);await assert.rejects(verifyWorkspaceMailEvent(signed.clone(),{token,appId:'another-app'}),/invalid/);const forged=new Request(signed.url,{method:'POST',headers:signed.headers,body:JSON.stringify({...event,messageId:'mail_forged',id:'mail_forged'})});await assert.rejects(verifyWorkspaceMailEvent(forged,{token,appId:app.id}),/unauthorized/);const oversized=new Request(signed.url,{method:'POST',headers:signed.headers,body:'a'.repeat(17000)});await assert.rejects(verifyWorkspaceMailEvent(oversized,{token,appId:app.id}),/too_large/);await assert.rejects(verifyWorkspaceMailEvent(signed.clone(),{token,appId:app.id,now:Date.now()+600000}),/unauthorized/);await assert.rejects(deliverAppMailEvent(env,{...authority,orgId:'another-org'},event),/not_published/);}finally{globalThis.fetch=original;}
 });
});
