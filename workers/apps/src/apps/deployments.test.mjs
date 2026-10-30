import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createDeploymentArtifact } from "../../../../packages/cli/src/deployment-artifact.mjs";

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

class R2Object {
  constructor(value) {
    this.value = value;
  }

  async text() {
    return new TextDecoder().decode(this.value);
  }

  async arrayBuffer() {
    return this.value.slice().buffer;
  }
}

class R2Adapter {
  constructor() {
    this.objects = new Map();
  }

  async get(key) {
    const value = this.objects.get(key);
    return value ? new R2Object(value) : null;
  }

  async put(key, value) {
    this.objects.set(key, value instanceof Uint8Array ? value : new TextEncoder().encode(String(value)));
  }
}

let modulePromise;

async function loadModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-deployments-test-"));
  const outfile = join(outdir, "deployments.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./deployments.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function deploymentsModule() {
  modulePromise ??= loadModule();
  return modulePromise;
}

function createEnv({ appCode = "request-app" } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/apps/db/schema.sql", "utf8"));
  database.prepare(`
    INSERT INTO apps_apps (
      id,
      org_id,
      org_slug,
      owner_user_id,
      name,
      code,
      slug,
      description,
      type,
      status,
      visibility,
      login_required,
      agent_mcp_enabled,
      llm_enabled,
      data_service_id,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "app-1",
    "org-1",
    "workspace",
    "user-1",
    "Request App",
    appCode,
    appCode,
    "",
    "web",
    "draft",
    "org",
    1,
    0,
    0,
    "ds-1",
    "2026-07-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z"
  );
  database.prepare(`
    INSERT INTO apps_app_resources (
      id,
      app_id,
      data_service_id,
      type,
      provider,
      resource_name,
      resource_id,
      binding_name,
      environment,
      status,
      created_at
    )
    VALUES ('res-db', 'app-1', 'ds-1', 'd1_database', 'cloudflare-d1', 'apps-request-app-db', 'd1-real-1', 'DB', 'prod', 'ready', '2026-07-01T00:00:00.000Z')
  `).run();
  database.prepare(`
    INSERT INTO apps_app_resources (
      id,
      app_id,
      data_service_id,
      type,
      provider,
      resource_name,
      resource_id,
      binding_name,
      environment,
      status,
      created_at
    )
    VALUES ('res-pages', 'app-1', 'ds-1', 'pages_project', 'cloudflare-pages', 'apps-request-app-pages', 'pages-real-1', '', 'prod', 'ready', '2026-07-01T00:00:00.000Z')
  `).run();
  return {
    AUTH_ISSUER: "https://auth.example.test",
    AUTH_SERVICE_TOKEN: "auth-service-token",
    AUTH_WORKER_URL: "https://auth.example.test",
    CF_ACCOUNT_ID: "acct-1",
    CF_API_TOKEN: "cf-token",
    __cloudflareD1: new DatabaseSync(":memory:"),
    APPS_ARTIFACTS: new R2Adapter(),
    APPS_BASE_DOMAIN: "example.invalid",
    PLATFORM_MCP_URL: "https://apps.example.invalid/mcp",
    APPS_DB: new D1Adapter(database),
    APPS_SECRET_ENCRYPTION_KEY: "deployment-test-secret-encryption-key-32-plus"
  };
}

const principal = {
  name: "Ada Zhang",
  orgId: "org-1",
  orgSlug: "workspace",
  scopes: ["apps:apps:write", "apps:deploy:production"],
  sub: "user-1"
};

const AUTHENTICATED_WORKER_SOURCE = `
  import { WorkspaceBrowserAppSession } from "@frontier-workspace/auth";
  export default {
    async fetch(request, env) {
      const auth = new WorkspaceBrowserAppSession({
        appId: env.APP_ID,
        appOrigin: env.APP_ORIGIN,
        appSecret: env.APP_SECRET,
        appVersion: env.APP_VERSION,
        authOrigin: env.AUTH_ORIGIN,
        sessionSecret: env.SESSION_SECRET
      });
      if (new URL(request.url).pathname.endsWith("/callback")) return auth.callback(request);
      const session = await auth.read(request);
      return Response.json({ authenticated: Boolean(session) });
    }
  };
`;

function withCloudflarePagesMock(fn) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "");
    const method = (init.method || "GET").toUpperCase();
    const call = { body: init.body, headers: new Headers(init.headers), method, path };
    calls.push(call);

    if (url.origin === "https://auth.example.test" && path === "/v1/admin/apps" && method === "POST") {
      return jsonResponse({ id: JSON.parse(String(init.body || "{}")).id, status: "listed" });
    }
    if (url.origin === "https://auth.example.test" && path === "/v1/admin/resources" && method === "POST") {
      return jsonResponse({ id: JSON.parse(String(init.body || "{}")).id, status: "listed" });
    }
    if (path === "/accounts/acct-1/pages/projects/apps-request-app-pages" && method === "GET") {
      return jsonResponse({
        deployment_configs: {
          production: {
            compatibility_date: "2026-06-16",
            wrangler_config_hash: "cfg-hash"
          }
        },
        name: "apps-request-app-pages"
      });
    }
    if (path === "/accounts/acct-1/pages/projects/apps-request-app-pages" && method === "PATCH") {
      return jsonResponse({ name: "apps-request-app-pages" });
    }
    if (path === "/accounts/acct-1/pages/projects/apps-request-app-pages/upload-token" && method === "GET") {
      return jsonResponse({ jwt: "pages-upload-token" });
    }
    if (path === "/pages/assets/check-missing" && method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      return jsonResponse(body.hashes ?? []);
    }
    if (path === "/pages/assets/upload" && method === "POST") {
      return jsonResponse({ uploaded: true });
    }
    if (path === "/pages/assets/upsert-hashes" && method === "POST") {
      return jsonResponse({ updated: true });
    }
    if (path === "/accounts/acct-1/pages/projects/apps-request-app-pages/deployments" && method === "POST") {
      return jsonResponse({
        id: "cf-pages-dep-1",
        url: "https://request-app.pages.dev"
      });
    }
    if (path === "/accounts/acct-1/pages/projects/apps-request-app-pages/deployments/cf-pages-dep-1/rollback" && method === "POST") {
      return jsonResponse({ id: "cf-pages-dep-rollback" });
    }
    return jsonResponse({ path, method }, 404);
  };

  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

function withCloudflareWorkerMock(fn, options = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let queueConsumers = [...(options.queueConsumers ?? [])];
  let cronSchedules = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "");
    const method = (init.method || "GET").toUpperCase();
    const call = { body: init.body, headers: new Headers(init.headers), method, path };
    calls.push(call);

    if (url.origin === "https://auth.example.test" && path === "/v1/admin/apps" && method === "POST") {
      return jsonResponse({ id: JSON.parse(String(init.body || "{}")).id, status: "listed" });
    }
    if (path === "/accounts/acct-1/workers/scripts/apps-request-app-worker/versions" && method === "POST") {
      return jsonResponse({ id: "worker-version-1" });
    }
    if (path === "/accounts/acct-1/workers/scripts/apps-request-app-worker/assets-upload-session" && method === "POST") {
      const manifest = JSON.parse(String(init.body || "{}")).manifest || {};
      const jwt = options.singleAssetUploads
        ? `header.${Buffer.from(JSON.stringify({ wrangler_single_asset_uploads: true })).toString("base64url")}.signature`
        : "worker-assets-upload-token";
      return jsonResponse({ jwt, buckets: [Object.values(manifest).map((item) => item.hash)] });
    }
    if (path === "/accounts/acct-1/workers/assets/upload" && method === "POST") {
      return jsonResponse({ jwt: "worker-assets-completion-token" });
    }
    if (path.startsWith("/accounts/acct-1/workers/assets/upload/") && method === "POST") {
      return jsonResponse({ jwt: "worker-assets-completion-token" });
    }
    if (path === "/accounts/acct-1/workers/scripts/apps-request-app-worker" && method === "GET") {
      return jsonResponse({ id: "apps-request-app-worker" });
    }
    if (path === "/accounts/acct-1/workers/scripts/apps-request-app-worker/deployments" && method === "GET") {
      return jsonResponse({
        deployments: [
          {
            versions: [
              { percentage: 100, version_id: "worker-version-1" }
            ]
          }
        ]
      });
    }
    if (path === "/accounts/acct-1/workers/scripts/apps-request-app-worker/deployments" && method === "POST") {
      return jsonResponse({ id: "worker-rollback-deployment" });
    }
    if (path === "/accounts/acct-1/hyperdrive/configs" && method === "GET") {
      return jsonResponse([]);
    }
    if (path === "/accounts/acct-1/hyperdrive/configs" && method === "POST") {
      return jsonResponse({ id: "hyperdrive-real-1", name: "apps-request-app-hyperdrive" });
    }
    if (path === "/accounts/acct-1/queues/queue-real-1/consumers" && method === "GET") {
      return jsonResponse(queueConsumers);
    }
    if (path === "/accounts/acct-1/queues/queue-real-1/consumers" && method === "POST") {
      const consumer = { consumer_id: "consumer-real-1", ...JSON.parse(String(init.body || "{}")) };
      queueConsumers = [consumer];
      return jsonResponse(consumer);
    }
    if (path === "/accounts/acct-1/queues/queue-real-1/consumers/consumer-real-1" && method === "PUT") {
      const consumer = { consumer_id: "consumer-real-1", ...JSON.parse(String(init.body || "{}")) };
      queueConsumers = [consumer];
      return jsonResponse(consumer);
    }
    if (path === "/accounts/acct-1/workers/scripts/apps-request-app-worker/schedules" && method === "PUT") {
      cronSchedules = JSON.parse(String(init.body || "[]"));
      return jsonResponse({ schedules: cronSchedules });
    }
    if (path === "/accounts/acct-1/workers/scripts/apps-request-app-worker/schedules" && method === "GET") {
      return jsonResponse({ schedules: cronSchedules });
    }
    return jsonResponse({ path, method }, 404);
  };

  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

function withCloudflareD1Mock(env, fn) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "");
    const method = (init.method || "GET").toUpperCase();
    calls.push({ body: init.body, method, path });
    if (path === "/accounts/acct-1/d1/database/d1-real-1/query" && method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      if (Array.isArray(body.batch)) {
        const results = [];
        env.__cloudflareD1.exec("BEGIN");
        try {
          for (const query of body.batch) {
            env.__cloudflareD1.exec(String(query.sql || ""));
            results.push({ results: [], success: true });
          }
          env.__cloudflareD1.exec("COMMIT");
          return jsonResponse(results);
        } catch (error) {
          env.__cloudflareD1.exec("ROLLBACK");
          return new Response(JSON.stringify({
            errors: [{ code: 7500, message: error instanceof Error ? error.message : "batch failed" }],
            result: results,
            success: false
          }), {
            headers: { "content-type": "application/json" },
            status: 400
          });
        }
      }
      const sql = String(body.sql || "");
      if (/^\s*SELECT\b/i.test(sql)) {
        const rows = env.__cloudflareD1.prepare(sql).all();
        return jsonResponse([{ results: rows, success: true }]);
      }
      env.__cloudflareD1.exec(sql);
      return jsonResponse([{ results: [], success: true }]);
    }
    if (path === "/accounts/acct-1/d1/database" && method === "GET" && url.searchParams.get("name") === "apps-request-app-db") {
      return jsonResponse([{ name: "apps-request-app-db", uuid: "d1-real-1" }]);
    }
    return jsonResponse({ path, method }, 404);
  };

  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

function jsonResponse(result, status = 200) {
  return new Response(JSON.stringify({ result, success: status < 400 }), {
    headers: { "content-type": "application/json" },
    status
  });
}

async function encryptForTest(keyMaterial, value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial));
  const key = await crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return {
    cipherIv: bytesToBase64(iv),
    cipherText: bytesToBase64(new Uint8Array(cipher))
  };
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("APPS MCP app deployment helpers", () => {
  it("blocks an authenticated App bundle that trusts caller identity headers before upload", async () => {
    const env = createEnv();
    const { deployWorkerSource } = await deploymentsModule();
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      await withCloudflareWorkerMock(async (calls) => {
        await assert.rejects(
          () => deployWorkerSource({
            appId: "app-1",
            entrypoint: "index.js",
            files: [{
              path: "index.js",
              content: `
                import { WorkspaceAuthServer } from "@frontier-workspace/auth";
                export default { async fetch(request, env) {
                  const auth = new WorkspaceAuthServer({ appId: env.APP_ID, authOrigin: env.AUTH_ORIGIN });
                  await auth.exchangeLaunch({ code: "one-time-code" });
                  return Response.json({
                    id: request.headers.get("x-workspace-user-id"),
                    role: request.headers.get("x-workspace-role")
                  });
                } };
              `,
              contentType: "application/javascript; charset=utf-8"
            }],
            version: "unsafe-v1"
          }, env, principal),
          (error) => error.status === 422
            && error.code === "auth_security_preflight_failed"
            && error.details?.security?.auth?.findings?.some((finding) => finding.code === "AUTH_UNTRUSTED_IDENTITY_HEADER")
        );
        assert.equal(calls.length, 0);
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  it("blocks an unsafe Cloudflare Pages _worker.bundle before any upload", async () => {
    const env = createEnv();
    const { deployAppSource } = await deploymentsModule();
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      await withCloudflarePagesMock(async (calls) => {
        await assert.rejects(
          () => deployAppSource({
            appId: "app-1",
            entrypoint: "index.html",
            files: [
              { path: "index.html", content: "<!doctype html><main>Unsafe</main>" },
              {
                path: "_worker.bundle",
                content: `export default { fetch(request) { return Response.json({ role: request.headers.get("x-workspace-role") }); } };`
              }
            ],
            version: "unsafe-pages-v1"
          }, env, principal),
          (error) => error.status === 422
            && error.details?.security?.auth?.findings?.some((finding) => finding.code === "AUTH_UNTRUSTED_IDENTITY_HEADER")
        );
        assert.equal(calls.length, 0);
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  it("blocks changing loginRequired between source inspection and publication", async () => {
    const env = createEnv();
    const { publishDeployment } = await deploymentsModule();
    await env.APPS_DB.prepare("UPDATE apps_apps SET login_required = 0 WHERE id = ?").bind("app-1").run();
    await env.APPS_DB.prepare(`
      INSERT INTO apps_deployments (id, app_id, environment, version, status, url, created_by, created_at)
      VALUES ('dep-policy-gap', 'app-1', 'production', 'unsafe-policy-gap', 'ready', 'https://request-app.example.invalid', 'user-1', '2026-07-16T00:00:00.000Z')
    `).run();

    await assert.rejects(
      () => publishDeployment({
        appId: "app-1",
        deploymentId: "dep-policy-gap",
        loginRequired: true
      }, env, principal),
      (error) => error.status === 409 && error.code === "auth_policy_change_requires_redeployment"
    );
    const deployment = await env.APPS_DB
      .prepare("SELECT status FROM apps_deployments WHERE id = ?")
      .bind("dep-policy-gap")
      .first();
    assert.equal(deployment.status, "ready");
  });

  it("allows a public App to publish an authenticated deployment verified for collaborators and Owner", async () => {
    const env = createEnv();
    const { deployAppSource, publishDeployment } = await deploymentsModule();
    await env.APPS_DB.prepare("UPDATE apps_apps SET login_required = 0, visibility = 'public', access_targets_json = '[]' WHERE id = ?").bind("app-1").run();

    await withCloudflarePagesMock(async () => {
      const result = await deployAppSource({
        appId: "app-1",
        entrypoint: "index.html",
        files: [
          { path: "index.html", content: "<!doctype html><main>Authenticated</main>" },
          { path: "_worker.bundle", content: AUTHENTICATED_WORKER_SOURCE }
        ],
        loginRequired: true,
        version: "authenticated-v1",
        visibility: "private"
      }, env, principal);

      assert.equal(result.deployment.loginRequired, true);
      assert.equal(result.deployment.visibility, "private");
      await publishDeployment({ appId: "app-1", deploymentId: result.deployment.id }, env, principal);
    });

    const app = await env.APPS_DB.prepare("SELECT login_required, visibility, access_targets_json FROM apps_apps WHERE id = ?").bind("app-1").first();
    assert.equal(app.login_required, 1);
    assert.equal(app.visibility, "private");
    assert.equal(app.access_targets_json, "[]");
  });

  it("allows an authenticated App to publish a public deployment without an access scope", async () => {
    const env = createEnv();
    const { deployAppSource, publishDeployment } = await deploymentsModule();

    await withCloudflarePagesMock(async () => {
      const result = await deployAppSource({
        appId: "app-1",
        entrypoint: "index.html",
        files: [{ path: "index.html", content: "<!doctype html><main>Public</main>" }],
        loginRequired: false,
        version: "public-v1"
      }, env, principal);

      assert.equal(result.deployment.loginRequired, false);
      assert.equal(result.deployment.visibility, "public");
      assert.deepEqual(result.deployment.accessTargets, []);
      await publishDeployment({ appId: "app-1", deploymentId: result.deployment.id }, env, principal);
    });

    const app = await env.APPS_DB.prepare("SELECT login_required, visibility, access_targets_json FROM apps_apps WHERE id = ?").bind("app-1").first();
    assert.equal(app.login_required, 0);
    assert.equal(app.visibility, "public");
    assert.equal(app.access_targets_json, "[]");
  });

  it("requires and snapshots a valid MCP Manifest before an MCP-enabled App upload", async () => {
    const env = createEnv();
    const { deployAppSource, publishDeployment } = await deploymentsModule();
    await env.APPS_DB.prepare("UPDATE apps_apps SET agent_mcp_enabled = 1 WHERE id = ?").bind("app-1").run();
    const files = [
      { path: "index.html", content: "<!doctype html><main>MCP App</main>" },
      { path: "_worker.bundle", content: AUTHENTICATED_WORKER_SOURCE },
    ];

    await withCloudflarePagesMock(async (calls) => {
      await assert.rejects(
        () => deployAppSource({ appId: "app-1", entrypoint: "index.html", files, version: "mcp-v1" }, env, principal),
        (error) => error.status === 422 && error.code === "app_mcp_manifest_required",
      );
      assert.equal(calls.length, 0);

      const manifest = {
        schemaVersion: "workspace.app-mcp/v1",
        appId: "app-1",
        name: "Request App",
        baseUrl: "https://request-app.example.invalid",
        audience: "https://request-app.example.invalid",
        resourceId: "app-mcp:app-1",
        toolDefinitionVersion: "1",
        authorization: {
          model: "app-rbac",
          defaultRole: "member",
          toolsEndpoint: "/api/v1/mcp/tools",
          toolsEndpointScope: "app:mcp:discover",
          roles: [{ id: "member", name: "Member" }],
        },
        tools: [{
          name: "request_list",
          description: "List requests.",
          method: "GET",
          path: "/api/v1/requests",
          allowedRoles: ["member"],
          requiredScopes: ["requests:read"],
          readOnly: true,
          riskLevel: "low",
          requiresConfirmation: false,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
      };
      const result = await deployAppSource({
        appId: "app-1",
        entrypoint: "index.html",
        files: [...files, {
          path: ".well-known/workspace-mcp-manifest.json",
          content: JSON.stringify(manifest),
          contentType: "application/json",
        }],
        version: "mcp-v1",
      }, env, principal);

      const snapshot = await env.APPS_DB.prepare(`
        SELECT app_id AS appId, deployment_id AS deploymentId, manifest_sha256 AS manifestSha256
        FROM apps_app_mcp_manifests WHERE deployment_id = ?
      `).bind(result.deployment.id).first();
      assert.equal(snapshot.appId, "app-1");
      assert.equal(snapshot.deploymentId, result.deployment.id);
      assert.match(snapshot.manifestSha256, /^[a-f0-9]{64}$/);

      await publishDeployment({ appId: "app-1", deploymentId: result.deployment.id }, env, principal);
      const resourceCall = calls.find((call) => call.path === "/v1/admin/resources" && call.method === "POST");
      assert.ok(resourceCall);
      const resource = JSON.parse(String(resourceCall.body));
      assert.equal(resource.id, "app-mcp:app-1");
      assert.equal(resource.audience, "https://request-app.example.invalid");
      assert.deepEqual(resource.allowedScopes, ["app:mcp:discover", "requests:read"]);
    });
  });

  it("deploys Pages source through Cloudflare APIs and records the deployment", async () => {
    const env = createEnv();
    const { appSourceRuntimeResponse, deployAppSource, publishDeployment, rollbackDeployment } = await deploymentsModule();
    await env.APPS_DB.prepare(`
      INSERT INTO apps_app_resources (
        id, app_id, data_service_id, type, provider, resource_name, resource_id,
        binding_name, environment, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prod', 'ready', ?)
    `).bind(
      "res-queue", "app-1", "ds-1", "queue", "cloudflare-queues",
      "apps-request-app-queue", "queue-real-1", "QUEUE", "2026-07-01T00:00:00.000Z"
    ).run();
    await env.APPS_DB.prepare(`
      INSERT INTO apps_app_resources (
        id, app_id, data_service_id, type, provider, resource_name, resource_id,
        binding_name, environment, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prod', 'ready', ?)
    `).bind(
      "res-hyperdrive", "app-1", "ds-1", "hyperdrive_config", "cloudflare-hyperdrive",
      "apps-request-app-hyperdrive", "hyperdrive-ready-1", "HYPERDRIVE", "2026-07-01T00:00:00.000Z"
    ).run();
    await env.APPS_DB.prepare(`
      INSERT INTO apps_app_source_snapshots (
        id, app_id, version, content_sha256, archive_key, archive_sha256,
        archive_format, file_count, source_size_bytes, archive_size_bytes,
        created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'zip', ?, ?, ?, ?, ?)
    `).bind(
      "snap-1", "app-1", "source-v1", "a".repeat(64),
      "apps/app-1/source-snapshots/snap-1/source.zip", "b".repeat(64),
      2, 100, 80, "user-1", "2026-08-09T00:00:00.000Z"
    ).run();

    await withCloudflarePagesMock(async (calls) => {
      const result = await deployAppSource({
        appId: "app-1",
        sourceSnapshotId: "snap-1",
        entrypoint: "index.html",
        files: [
          {
            path: "index.html",
            content: "<!doctype html><h1>Hello from MCP</h1>",
            contentType: "text/html; charset=utf-8"
          },
          {
            path: "_worker.bundle",
            content: AUTHENTICATED_WORKER_SOURCE,
            contentType: "application/javascript; charset=utf-8"
          }
        ],
        version: "1.0.0",
        versionName: "First production",
        releaseNotes: "Initial authenticated release"
      }, env, principal);

      assert.equal(result.deployment.status, "ready");
      assert.equal(result.deployment.sourceSnapshotId, "snap-1");
      assert.equal(result.deployment.version, "1.0.0");
      assert.equal(result.deployment.versionName, "First production");
      assert.equal(result.deployment.releaseNotes, "Initial authenticated release");
      assert.equal(result.deployment.createdByName, "Ada Zhang");
      assert.equal(result.sourceVersion.fileCount, 2);
      assert.match(result.sourceVersion.artifactKey, /^cloudflare:\/\/pages\/apps-request-app-pages\//);

      const patchCall = calls.find((call) => call.path === "/accounts/acct-1/pages/projects/apps-request-app-pages" && call.method === "PATCH");
      assert.ok(patchCall);
      const patchBody = JSON.parse(String(patchCall.body));
      assert.deepEqual(patchBody.deployment_configs.production.d1_databases.DB, { id: "d1-real-1" });
      assert.deepEqual(patchBody.deployment_configs.production.hyperdrive_bindings.HYPERDRIVE, { id: "hyperdrive-ready-1" });
      assert.deepEqual(patchBody.deployment_configs.production.queue_producers.QUEUE, { name: "apps-request-app-queue" });
      assert.ok(patchBody.deployment_configs.production.compatibility_flags.includes("nodejs_compat"));

      const uploadCall = calls.find((call) => call.path === "/pages/assets/upload" && call.method === "POST");
      assert.ok(uploadCall);
      assert.equal(uploadCall.headers.get("authorization"), "Bearer pages-upload-token");

      const deploymentCall = calls.find((call) => call.path === "/accounts/acct-1/pages/projects/apps-request-app-pages/deployments" && call.method === "POST");
      assert.ok(deploymentCall);
      assert.ok(deploymentCall.body instanceof FormData);
      const manifest = JSON.parse(String(deploymentCall.body.get("manifest")));
      assert.deepEqual(Object.keys(manifest), ["/index.html"]);
      const workerBundle = await deploymentCall.body.get("_worker.bundle").text();
      assert.match(workerBundle, /name="metadata"/);
      assert.match(workerBundle, /main_module/);
      assert.match(workerBundle, /WorkspaceBrowserAppSession/);

      const appRow = await env.APPS_DB.prepare("SELECT status FROM apps_apps WHERE id = ?").bind("app-1").first();
      assert.equal(appRow.status, "draft");
      const deploymentRow = await env.APPS_DB.prepare("SELECT source_snapshot_id AS sourceSnapshotId, version_name AS versionName, release_notes AS releaseNotes, created_by_name AS createdByName FROM apps_deployments WHERE id = ?").bind(result.deployment.id).first();
      assert.equal(deploymentRow.sourceSnapshotId, "snap-1");
      assert.equal(deploymentRow.versionName, "First production");
      assert.equal(deploymentRow.releaseNotes, "Initial authenticated release");
      assert.equal(deploymentRow.createdByName, "Ada Zhang");

      const previewAuthCalls = calls.filter((call) => call.path === "/v1/admin/apps" && call.method === "POST");
      assert.equal(previewAuthCalls.length, 1);
      assert.equal(previewAuthCalls[0].headers.get("authorization"), "Bearer auth-service-token");
      const previewAuthPayload = JSON.parse(String(previewAuthCalls[0].body));
      assert.equal(previewAuthPayload.id, "app-1");
      assert.equal(previewAuthPayload.status, "draft");
      assert.equal(previewAuthPayload.sdkStatus, "connected");
      assert.equal(previewAuthPayload.accessMode, "targeted");
      assert.deepEqual(previewAuthPayload.accessTargets, []);
      assert.equal(previewAuthPayload.publisherUserId, "user-1");
      assert.deepEqual(previewAuthPayload.callbackUrls, [
        "https://request-app.example.invalid/auth/workspace/callback"
      ]);

      const beforePublish = await appSourceRuntimeResponse(new Request("https://request-app.example.invalid/"), env, { id: "app-1" }, "/");
      assert.equal(beforePublish, undefined);

      await env.APPS_DB
        .prepare("UPDATE apps_apps SET visibility = 'team', access_targets_json = ? WHERE id = ?")
        .bind(JSON.stringify(["department:HR"]), "app-1")
        .run();

      env.WORKSPACE_RELEASE_READINESS_REPORT_REQUIRED = "true";
      await assert.rejects(
        () => publishDeployment({
          appId: "app-1",
          deploymentId: result.deployment.id,
          visibility: "org"
        }, env, principal),
        (error) => error.status === 400 && error.code === "invalid_harness_report_url"
      );

      const publishResult = await publishDeployment({
        appId: "app-1",
        deploymentId: result.deployment.id,
        harnessReportUrl: "https://request-app.example.invalid/harness/report.html",
        harnessSelfCheckConfirmed: true,
        visibility: "org"
      }, env, principal);
      assert.equal(publishResult.deployment.status, "published");
      assert.equal(publishResult.deployment.harnessReportUrl, "https://request-app.example.invalid/harness/report.html");
      assert.equal(publishResult.deployment.harnessSelfCheckConfirmedBy, "user-1");
      assert.ok(publishResult.deployment.harnessSelfCheckConfirmedAt);
      const authCalls = calls.filter((call) => call.path === "/v1/admin/apps" && call.method === "POST");
      assert.equal(authCalls.length, 2);
      const authCall = authCalls.at(-1);
      assert.ok(authCall);
      assert.equal(authCall.headers.get("authorization"), "Bearer auth-service-token");
      const authPayload = JSON.parse(String(authCall.body));
      assert.equal(authPayload.id, "app-1");
      assert.equal(authPayload.status, "listed");
      assert.equal(authPayload.sdkStatus, "connected");
      assert.equal(authPayload.accessMode, "public");
      assert.deepEqual(authPayload.accessTargets, []);
      assert.deepEqual(authPayload.callbackUrls, [
        "https://request-app.example.invalid/auth/workspace/callback"
      ]);
      const publishedApp = await env.APPS_DB
        .prepare("SELECT visibility, access_targets_json FROM apps_apps WHERE id = ?")
        .bind("app-1")
        .first();
      assert.equal(publishedApp.visibility, "org");
      assert.deepEqual(JSON.parse(publishedApp.access_targets_json), []);

      const rollbackResult = await rollbackDeployment({
        appId: "app-1",
        deploymentId: result.deployment.id
      }, env, principal);
      assert.equal(rollbackResult.deployment.status, "published");
      assert.ok(calls.some((call) => call.path === "/accounts/acct-1/pages/projects/apps-request-app-pages/deployments/cf-pages-dep-1/rollback" && call.method === "POST"));
    });
  });

  it("deploys Worker source and syncs configured secrets through Cloudflare APIs", async () => {
    const env = createEnv();
    env.APPS_SECRET_ENCRYPTION_KEY = "test-secret-key";
    const encrypted = await encryptForTest(env.APPS_SECRET_ENCRYPTION_KEY, "worker-secret-value");
    const encryptedHyperdrivePassword = await encryptForTest(env.APPS_SECRET_ENCRYPTION_KEY, "database-password-value");
    await env.APPS_DB.prepare(`
      INSERT INTO apps_app_resources (
        id,
        app_id,
        data_service_id,
        type,
        provider,
        resource_name,
        resource_id,
        binding_name,
        environment,
        status,
        created_at
      )
      VALUES ('res-worker', 'app-1', 'ds-1', 'worker', 'cloudflare-workers', 'apps-request-app-worker', 'apps-request-app-worker', '', 'prod', 'ready', '2026-07-01T00:00:00.000Z')
    `).run();
    await env.APPS_DB.prepare(`
      INSERT INTO apps_app_env_vars (
        id,
        app_id,
        org_id,
        name,
        target,
        environment,
        value,
        created_by,
        updated_by,
        created_at,
        updated_at
      )
      VALUES ('var-1', 'app-1', 'org-1', 'FEATURE_FLAG', 'worker', 'production', 'enabled', 'user-1', 'user-1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    `).run();
    await env.APPS_DB.prepare(`
      INSERT INTO apps_app_secrets (
        id,
        app_id,
        org_id,
        name,
        environment,
        description,
        required,
        status,
        cipher_text,
        cipher_iv,
        algorithm,
        configured_by,
        configured_at,
        declared_by,
        created_at,
        updated_at
      )
      VALUES ('sec-1', 'app-1', 'org-1', 'WORKER_TOKEN', 'production', '', 1, 'configured', ?, ?, 'AES-GCM', 'user-1', '2026-07-01T00:00:00.000Z', 'user-1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    `).bind(encrypted.cipherText, encrypted.cipherIv).run();
    await env.APPS_DB.prepare(`
      INSERT INTO apps_app_secrets (
        id, app_id, org_id, name, environment, description, required, status,
        cipher_text, cipher_iv, algorithm, configured_by, configured_at,
        declared_by, created_at, updated_at
      ) VALUES (
        'sec-hyperdrive', 'app-1', 'org-1', 'HYPERDRIVE_PASSWORD', 'production',
        'Platform-only Hyperdrive password', 1, 'configured', ?, ?, 'AES-GCM',
        'user-1', '2026-07-01T00:00:00.000Z', 'user-1',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
      )
    `).bind(encryptedHyperdrivePassword.cipherText, encryptedHyperdrivePassword.cipherIv).run();
    await env.APPS_DB.prepare(`
      INSERT INTO apps_app_resources (
        id, app_id, data_service_id, type, provider, resource_name, resource_id,
        binding_name, environment, status, created_at
      )
      VALUES (
        'res-r2', 'app-1', 'ds-1', 'r2_bucket', 'cloudflare-r2',
        'apps-request-app-r2', 'apps-request-app-r2', 'UPLOADS', 'prod', 'ready',
        '2026-07-01T00:00:00.000Z'
      )
    `).run();
    await env.APPS_DB.prepare(`
      INSERT INTO apps_app_resources (
        id, app_id, data_service_id, type, provider, resource_name, resource_id,
        binding_name, environment, status, created_at
      ) VALUES (
        'res-cron', 'app-1', 'ds-1', 'cron_trigger', 'cloudflare',
        'apps-request-app-cron', '', '', 'prod', 'placeholder',
        '2026-07-01T00:00:00.000Z'
      )
    `).run();
    await env.APPS_DB.prepare(`
      INSERT INTO apps_app_resources (
        id, app_id, data_service_id, type, provider, resource_name, resource_id,
        binding_name, environment, status, created_at
      ) VALUES (
        'res-hyperdrive', 'app-1', 'ds-1', 'hyperdrive_config', 'cloudflare-hyperdrive',
        'apps-request-app-hyperdrive', '', 'HYPERDRIVE', 'prod', 'placeholder',
        '2026-07-01T00:00:00.000Z'
      )
    `).run();
    await env.APPS_DB.prepare(`
      INSERT INTO apps_app_resources (
        id, app_id, data_service_id, type, provider, resource_name, resource_id,
        binding_name, environment, status, created_at
      )
      VALUES (
        'res-queue', 'app-1', 'ds-1', 'queue', 'cloudflare-queues',
        'apps-request-app-queue', 'queue-real-1', 'TASKS', 'prod', 'ready',
        '2026-07-01T00:00:00.000Z'
      )
    `).run();

    const { deployWorkerSource, publishDeployment, rollbackDeployment } = await deploymentsModule();
    await withCloudflareWorkerMock(async (calls) => {
      const result = await deployWorkerSource({
        appId: "app-1",
        entrypoint: "index.js",
        files: [
          {
            path: "index.js",
            content: AUTHENTICATED_WORKER_SOURCE,
            contentType: "application/javascript; charset=utf-8"
          }
        ],
        hyperdrive: {
          database: "appdb",
          host: "db.example.test",
          originConnectionLimit: 20,
          port: 5432,
          scheme: "postgres",
          user: "appuser"
        },
        cronSchedules: ["*/5 * * * *"],
        queueConsumer: {
          bindingName: "TASKS",
          maxBatchSize: 10,
          maxBatchTimeout: 5,
          maxRetries: 3
        },
        version: "worker-v1"
      }, env, principal);

      assert.equal(result.deployment.status, "ready");
      assert.equal(result.sourceVersion.artifactKey, "cloudflare://workers/apps-request-app-worker/worker-version-1");
      const scriptCall = calls.find((call) => call.path === "/accounts/acct-1/workers/scripts/apps-request-app-worker/versions" && call.method === "POST");
      assert.ok(scriptCall);
      const metadata = JSON.parse(await scriptCall.body.get("metadata").text());
      assert.deepEqual(metadata.bindings.find((binding) => binding.name === "FEATURE_FLAG"), {
        name: "FEATURE_FLAG",
        text: "enabled",
        type: "plain_text"
      });
      assert.deepEqual(metadata.bindings.find((binding) => binding.name === "DB"), {
        id: "d1-real-1",
        name: "DB",
        type: "d1"
      });
      assert.deepEqual(metadata.bindings.find((binding) => binding.name === "UPLOADS"), {
        bucket_name: "apps-request-app-r2",
        name: "UPLOADS",
        type: "r2_bucket"
      });
      assert.deepEqual(metadata.bindings.find((binding) => binding.name === "TASKS"), {
        name: "TASKS",
        queue_name: "apps-request-app-queue",
        type: "queue"
      });
      assert.deepEqual(metadata.bindings.find((binding) => binding.name === "HYPERDRIVE"), {
        id: "hyperdrive-real-1",
        name: "HYPERDRIVE",
        type: "hyperdrive"
      });
      assert.ok(metadata.compatibility_flags.includes("nodejs_compat"));
      assert.deepEqual(metadata.bindings.find((binding) => binding.name === "AUTH_SERVICE"), {
        name: "AUTH_SERVICE",
        service: "workspace-auth-worker",
        type: "service"
      });
      assert.deepEqual(metadata.bindings.find((binding) => binding.name === "WORKER_TOKEN"), {
        name: "WORKER_TOKEN",
        text: "worker-secret-value",
        type: "secret_text"
      });
      assert.equal(metadata.bindings.some((binding) => binding.name === "HYPERDRIVE_PASSWORD"), false);

      assert.equal(calls.some((call) => call.path.endsWith("/schedules") && call.method === "PUT"), false);
      assert.equal(calls.some((call) => call.path.endsWith("/consumers") && call.method === "POST"), false);
      await publishDeployment({ appId: "app-1", deploymentId: result.deployment.id }, env, principal);

      const schedulesCall = calls.find((call) => call.path === "/accounts/acct-1/workers/scripts/apps-request-app-worker/schedules" && call.method === "PUT");
      assert.ok(schedulesCall);
      assert.deepEqual(JSON.parse(String(schedulesCall.body)), [{ cron: "*/5 * * * *" }]);
      const cronResource = await env.APPS_DB.prepare("SELECT provider, resource_id AS resourceId, status FROM apps_app_resources WHERE id = 'res-cron'").first();
      assert.deepEqual({ ...cronResource }, {
        provider: "cloudflare-workers",
        resourceId: "apps-request-app-worker",
        status: "ready"
      });

      const queueConsumerCall = calls.find((call) => call.path === "/accounts/acct-1/queues/queue-real-1/consumers" && call.method === "POST");
      assert.ok(queueConsumerCall);
      assert.deepEqual(JSON.parse(String(queueConsumerCall.body)), {
        script_name: "apps-request-app-worker",
        settings: {
          batch_size: 10,
          max_retries: 3,
          max_wait_time_ms: 5000
        },
        type: "worker"
      });

      const hyperdriveCall = calls.find((call) => call.path === "/accounts/acct-1/hyperdrive/configs" && call.method === "POST");
      assert.ok(hyperdriveCall);
      const hyperdriveBody = JSON.parse(String(hyperdriveCall.body));
      assert.deepEqual(hyperdriveBody, {
        name: "apps-request-app-hyperdrive",
        origin: {
          database: "appdb",
          host: "db.example.test",
          password: "database-password-value",
          port: 5432,
          scheme: "postgres",
          user: "appuser"
        },
        origin_connection_limit: 20
      });
      const hyperdriveResource = await env.APPS_DB.prepare("SELECT resource_id AS resourceId, status FROM apps_app_resources WHERE id = 'res-hyperdrive'").first();
      assert.equal(hyperdriveResource.resourceId, "hyperdrive-real-1");
      assert.equal(hyperdriveResource.status, "ready");

      const promotionIndex = calls.findIndex((call) => call.path === "/accounts/acct-1/workers/scripts/apps-request-app-worker/deployments" && call.method === "POST");
      const schedulesIndex = calls.findIndex((call) => call.path === "/accounts/acct-1/workers/scripts/apps-request-app-worker/schedules" && call.method === "PUT");
      assert.ok(promotionIndex >= 0 && schedulesIndex > promotionIndex);

      await rollbackDeployment({
        appId: "app-1",
        deploymentId: result.deployment.id
      }, env, principal);
      const deploymentCalls = calls.filter((call) => call.path === "/accounts/acct-1/workers/scripts/apps-request-app-worker/deployments" && call.method === "POST");
      assert.equal(deploymentCalls.length, 2);
      const rollbackBody = JSON.parse(String(deploymentCalls.at(-1).body));
      assert.deepEqual(rollbackBody.versions, [{ percentage: 100, version_id: "worker-version-1" }]);
    });
  });

  it("deploys a Worker from a CLI artifact without inline MCP files", async () => {
    const env = createEnv();
    const directory = await mkdtemp(join(tmpdir(), "apps-deploy-artifact-test-"));
    try {
      const workerDirectory = join(directory, "worker");
      const assetsDirectory = join(directory, "assets");
      await mkdir(workerDirectory, { recursive: true });
      await mkdir(assetsDirectory, { recursive: true });
      await mkdir(join(workerDirectory, ".well-known"), { recursive: true });
      await writeFile(join(workerDirectory, "index.js"), AUTHENTICATED_WORKER_SOURCE);
      await writeFile(join(workerDirectory, "index.js.map"), JSON.stringify({ version: 3, sources: ["index.ts"] }));
      await writeFile(join(workerDirectory, ".well-known/workspace-mcp-manifest.json"), JSON.stringify({ schemaVersion: "workspace.app-mcp/v1" }));
      await writeFile(join(assetsDirectory, "index.html"), "<!doctype html><main>Request App</main>");
      await writeFile(join(assetsDirectory, "logo.png"), Uint8Array.from([0, 1, 2, 3, 255]));
      const artifact = await createDeploymentArtifact(workerDirectory, {
        target: "worker",
        entrypoint: "index.js",
        assets: {
          sourceDirectory: assetsDirectory,
          binding: "ASSETS",
          notFoundHandling: "single-page-application",
          runWorkerFirst: true
        }
      });
      const artifactKey = "apps/app-1/deploy-artifacts/artifact-1/artifact.zip";
      await env.APPS_ARTIFACTS.put(artifactKey, artifact.archive);
      await env.APPS_DB.prepare(`
        INSERT INTO apps_app_deploy_artifacts (
          id, app_id, version, target, entrypoint, content_sha256, archive_key,
          archive_sha256, file_count, content_size_bytes, archive_size_bytes,
          manifest_json, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        "artifact-1", "app-1", "worker-artifact-v1", "worker", artifact.entrypoint,
        artifact.contentSha256, artifactKey, artifact.archiveSha256, artifact.fileCount,
        artifact.contentSizeBytes, artifact.archive.byteLength, JSON.stringify(artifact.manifest),
        "user-1", "2026-08-10T00:00:00.000Z"
      ).run();
      await env.APPS_DB.prepare(`
        INSERT INTO apps_app_resources (
          id, app_id, data_service_id, type, provider, resource_name, resource_id,
          binding_name, environment, status, created_at
        ) VALUES (
          'res-worker-artifact', 'app-1', 'ds-1', 'worker', 'cloudflare-workers',
          'apps-request-app-worker', 'apps-request-app-worker', '', 'prod', 'ready',
          '2026-08-10T00:00:00.000Z'
        )
      `).run();

      const { deployWorkerSource } = await deploymentsModule();
      await withCloudflareWorkerMock(async (calls) => {
        const result = await deployWorkerSource({
          appId: "app-1",
          deployArtifactId: "artifact-1",
          version: "worker-artifact-v1"
        }, env, principal);

        assert.equal(result.deployment.deployArtifactId, "artifact-1");
        assert.equal(result.sourceVersion.artifactSha256, createHash("sha256").update(artifact.archive).digest("hex"));
        assert.equal(result.sourceVersion.fileCount, 5);
        const scriptCall = calls.find((call) => call.path === "/accounts/acct-1/workers/scripts/apps-request-app-worker/versions" && call.method === "POST");
        assert.ok(scriptCall);
        assert.equal(await scriptCall.body.get("index.js").text(), AUTHENTICATED_WORKER_SOURCE);
        assert.equal(scriptCall.body.get("index.js.map").type, "application/source-map");
        assert.equal(scriptCall.body.get(".well-known/workspace-mcp-manifest.json"), null);
        assert.equal(scriptCall.body.get(".workspace-assets/logo.png"), null);
        const metadata = JSON.parse(await scriptCall.body.get("metadata").text());
        assert.deepEqual(metadata.bindings.find((binding) => binding.name === "ASSETS"), { name: "ASSETS", type: "assets" });
        assert.deepEqual(metadata.assets.config, {
          html_handling: "auto-trailing-slash",
          not_found_handling: "single-page-application",
          run_worker_first: true
        });
        assert.equal(metadata.assets.jwt, "worker-assets-completion-token");
        const assetSessionCall = calls.find((call) => call.path === "/accounts/acct-1/workers/scripts/apps-request-app-worker/assets-upload-session");
        assert.ok(assetSessionCall);
        assert.equal(
          JSON.parse(String(assetSessionCall.body)).manifest["/index.html"].hash,
          "da5e5e33371856c81b9d06f1afb6b8a4"
        );
        assert.ok(calls.some((call) => call.path === "/accounts/acct-1/workers/assets/upload"));
        const row = await env.APPS_DB.prepare("SELECT deploy_artifact_id AS deployArtifactId FROM apps_deployments WHERE id = ?").bind(result.deployment.id).first();
        assert.equal(row.deployArtifactId, "artifact-1");
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("uploads Worker assets individually when Cloudflare requests the single-asset protocol", async () => {
    const env = createEnv();
    const directory = await mkdtemp(join(tmpdir(), "apps-single-asset-test-"));
    try {
      const workerDirectory = join(directory, "worker");
      const assetsDirectory = join(directory, "assets");
      await mkdir(join(workerDirectory, ".well-known"), { recursive: true });
      await mkdir(assetsDirectory, { recursive: true });
      await writeFile(join(workerDirectory, "index.js"), AUTHENTICATED_WORKER_SOURCE);
      await writeFile(join(workerDirectory, ".well-known/workspace-mcp-manifest.json"), JSON.stringify({ schemaVersion: "workspace.app-mcp/v1" }));
      await writeFile(join(assetsDirectory, "index.html"), "<!doctype html><main>Request App</main>");
      const artifact = await createDeploymentArtifact(workerDirectory, {
        target: "worker",
        entrypoint: "index.js",
        assets: { sourceDirectory: assetsDirectory, binding: "ASSETS", runWorkerFirst: true }
      });
      const artifactKey = "apps/app-1/deploy-artifacts/artifact-single/artifact.zip";
      await env.APPS_ARTIFACTS.put(artifactKey, artifact.archive);
      await env.APPS_DB.prepare(`
        INSERT INTO apps_app_deploy_artifacts (
          id, app_id, version, target, entrypoint, content_sha256, archive_key,
          archive_sha256, file_count, content_size_bytes, archive_size_bytes,
          manifest_json, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        "artifact-single", "app-1", "worker-single-v1", "worker", artifact.entrypoint,
        artifact.contentSha256, artifactKey, artifact.archiveSha256, artifact.fileCount,
        artifact.contentSizeBytes, artifact.archive.byteLength, JSON.stringify(artifact.manifest),
        "user-1", "2026-08-10T00:00:00.000Z"
      ).run();
      await env.APPS_DB.prepare(`
        INSERT INTO apps_app_resources (
          id, app_id, data_service_id, type, provider, resource_name, resource_id,
          binding_name, environment, status, created_at
        ) VALUES (
          'res-worker-single', 'app-1', 'ds-1', 'worker', 'cloudflare-workers',
          'apps-request-app-worker', 'apps-request-app-worker', '', 'prod', 'ready',
          '2026-08-10T00:00:00.000Z'
        )
      `).run();

      const { deployWorkerSource } = await deploymentsModule();
      await withCloudflareWorkerMock(async (calls) => {
        await deployWorkerSource({
          appId: "app-1",
          deployArtifactId: "artifact-single",
          version: "worker-single-v1"
        }, env, principal);

        const uploads = calls.filter((call) => call.path.startsWith("/accounts/acct-1/workers/assets/upload/"));
        assert.equal(uploads.length, 1);
        assert.equal(uploads[0].headers.get("content-type"), "text/html; charset=utf-8");
        assert.equal(new TextDecoder().decode(uploads[0].body), "<!doctype html><main>Request App</main>");
        assert.equal(calls.some((call) => call.path === "/accounts/acct-1/workers/assets/upload"), false);
      }, { singleAssetUploads: true });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("applies dedicated app D1 migrations and records the version", async () => {
    const env = createEnv();
    const { applyAppMigration } = await deploymentsModule();

    await withCloudflareD1Mock(env, async () => {
      const sql = `
          CREATE TABLE IF NOT EXISTS request_app_requests (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS request_app_requests_email_idx ON request_app_requests(email);
        `;
      const contentSha256 = createHash("sha256").update(sql).digest("hex");
      const result = await applyAppMigration({
        appId: "app-1",
        contentSha256,
        fileName: "001.sql",
        version: "001",
        sql
      }, env, principal);

      assert.equal(result.migration.status, "applied");
      assert.equal(result.migration.contentSha256, contentSha256);
      assert.equal(result.migration.fileName, "001.sql");
      assert.equal(result.migration.impact.dataStatementCount, 0);
      assert.deepEqual(result.migration.impact.statementTypes, ["create_table", "create_index"]);
      const table = env.__cloudflareD1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("request_app_requests");
      assert.equal(table.name, "request_app_requests");
      const index = env.__cloudflareD1.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get("request_app_requests_email_idx");
      assert.equal(index.name, "request_app_requests_email_idx");
      const registry = await env.APPS_DB.prepare("SELECT status, content_sha256 AS contentSha256, file_name AS fileName FROM apps_migration_registry WHERE app_id = ? AND version = ?").bind("app-1", "001").first();
      assert.equal(registry.status, "applied");
      assert.equal(registry.contentSha256, contentSha256);
      assert.equal(registry.fileName, "001.sql");

      const duplicate = await applyAppMigration({
        appId: "app-1",
        contentSha256,
        fileName: "001.sql",
        version: "001",
        sql
      }, env, principal);
      assert.equal(duplicate.deduplicated, true);

      await assert.rejects(
        () => applyAppMigration({ appId: "app-1", fileName: "001.sql", version: "001", sql: `${sql}\n-- drift` }, env, principal),
        (error) => error.status === 409 && error.code === "migration_content_drift"
      );
    });
  });

  it("executes every migration file as one atomic D1 batch", async () => {
    const env = createEnv();
    const { applyAppMigration } = await deploymentsModule();

    await withCloudflareD1Mock(env, async (calls) => {
      const sql = `
        CREATE TABLE IF NOT EXISTS request_app_atomic_records (id TEXT PRIMARY KEY);
        INSERT INTO request_app_atomic_records (id) VALUES ('one');
        INSERT INTO request_app_missing_records (id) VALUES ('two');
      `;
      await assert.rejects(
        () => applyAppMigration({
          allowDataMigrations: true,
          appId: "app-1",
          version: "atomic-failure",
          sql
        }, env, principal),
        (error) => error.status === 400 && error.code === "cloudflare_api_400"
      );

      const table = env.__cloudflareD1
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("request_app_atomic_records");
      assert.equal(table, undefined);
      const registry = await env.APPS_DB
        .prepare("SELECT COUNT(*) AS count FROM apps_migration_registry WHERE app_id = ? AND version = ?")
        .bind("app-1", "atomic-failure")
        .first();
      assert.equal(registry.count, 0);
      const queryCalls = calls.filter((call) => call.path.endsWith("/query"));
      assert.equal(queryCalls.length, 1);
      assert.equal(JSON.parse(String(queryCalls[0].body)).batch.length, 3);
    });
  });

  it("requires separate approval and applies only controlled App-prefixed data migrations", async () => {
    const env = createEnv();
    const { applyAppMigration } = await deploymentsModule();
    const sql = `
      CREATE TABLE IF NOT EXISTS request_app_records (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO request_app_records (id, value) VALUES ('seed', 'one')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value;
      UPDATE request_app_records SET value = 'two' WHERE id = 'seed';
      DELETE FROM request_app_records WHERE id = 'obsolete';
    `;

    await assert.rejects(
      () => applyAppMigration({ appId: "app-1", version: "data-no-approval", sql }, env, principal),
      (error) => error.status === 409 && error.code === "data_migration_approval_required"
    );

    await withCloudflareD1Mock(env, async () => {
      const result = await applyAppMigration({
        allowDataMigrations: true,
        appId: "app-1",
        tablePrefix: "request_app_",
        version: "data-approved",
        sql
      }, env, principal);
      assert.deepEqual(result.migration.impact.dataMutationTypes, ["delete", "insert", "update"]);
      assert.equal(result.migration.impact.dataStatementCount, 3);
      assert.deepEqual(result.migration.impact.dataTables, ["request_app_records"]);
      assert.equal(env.__cloudflareD1.prepare("SELECT value FROM request_app_records WHERE id = ?").get("seed").value, "two");
    });
  });

  it("allows an existing Workspace-prefixed platform App to migrate only its isolated D1 prefix", async () => {
    const env = createEnv({ appCode: "workspace-academy" });
    const { applyAppMigration } = await deploymentsModule();

    await withCloudflareD1Mock(env, async () => {
      const result = await applyAppMigration({
        appId: "app-1",
        version: "workspace-platform-app",
        sql: "CREATE TABLE IF NOT EXISTS workspace_academy_records (id TEXT PRIMARY KEY);"
      }, env, principal);
      assert.equal(result.migration.tablePrefix, "workspace_academy_");
      const table = env.__cloudflareD1
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("workspace_academy_records");
      assert.equal(table.name, "workspace_academy_records");
    });
  });

  it("continues rejecting every other platform-reserved migration prefix", async () => {
    const { applyAppMigration } = await deploymentsModule();

    for (const appCode of ["auth-service", "cf-tools", "d1-admin", "apps-builder", "sqlite-browser", "users-admin"]) {
      const env = createEnv({ appCode });
      await assert.rejects(
        () => applyAppMigration({
          appId: "app-1",
          version: `reserved-${appCode}`,
          sql: `CREATE TABLE ${appCode.replaceAll("-", "_")}_records (id TEXT PRIMARY KEY);`
        }, env, principal),
        (error) => error.status === 400 && error.code === "reserved_table_prefix"
      );
    }
  });

  it("rejects uncontrolled data targets, cross-table queries, unsafe WHERE omissions, and administrative SQL", async () => {
    const env = createEnv();
    const { applyAppMigration } = await deploymentsModule();
    const approved = { allowDataMigrations: true, appId: "app-1", tablePrefix: "request_app_" };

    await assert.rejects(
      () => applyAppMigration({ ...approved, version: "outside-prefix", sql: "INSERT INTO other_records (id) VALUES ('one');" }, env, principal),
      (error) => error.status === 400 && error.code === "migration_table_outside_app_prefix"
    );
    await assert.rejects(
      () => applyAppMigration({ ...approved, tablePrefix: "other_app_", version: "false-prefix-claim", sql: "INSERT INTO request_app_records (id) VALUES ('one');" }, env, principal),
      (error) => error.status === 400 && error.code === "invalid_app_table_prefix"
    );
    await assert.rejects(
      () => applyAppMigration({ ...approved, version: "system-table", sql: "INSERT INTO sqlite_shadow (id) VALUES ('one');" }, env, principal),
      (error) => error.status === 400 && error.code === "reserved_migration_identifier"
    );
    for (const [version, sql] of [
      ["update-no-where", "UPDATE request_app_records SET value = 'all';"],
      ["update-commented-where", "UPDATE request_app_records SET value = 'all' /* WHERE id = 'one' */;"],
      ["delete-no-where", "DELETE FROM request_app_records;"]
    ]) {
      await assert.rejects(
        () => applyAppMigration({ ...approved, version, sql }, env, principal),
        (error) => error.status === 400 && error.code === "data_migration_where_required"
      );
    }
    await assert.rejects(
      () => applyAppMigration({
        ...approved,
        version: "cross-query",
        sql: "INSERT INTO request_app_records (id, value) SELECT id, value FROM request_app_other;"
      }, env, principal),
      (error) => error.status === 400 && error.code === "data_migration_cross_resource_query_not_allowed"
    );
    await assert.rejects(
      () => applyAppMigration({
        ...approved,
        version: "qualified-target",
        sql: "INSERT INTO request_app_remote.request_app_records (id) VALUES ('one');"
      }, env, principal),
      (error) => error.status === 400 && error.code === "data_migration_cross_resource_query_not_allowed"
    );
    for (const [version, sql] of [
      ["pragma", "PRAGMA foreign_keys = OFF;"],
      ["attach", "ATTACH DATABASE 'other' AS other;"],
      ["drop", "DROP TABLE request_app_records;"]
    ]) {
      await assert.rejects(
        () => applyAppMigration({ ...approved, version, sql }, env, principal),
        (error) => error.status === 400 && error.code === "unsupported_migration_statement"
      );
    }
  });

  it("rejects migrations targeting reserved sqlite identifiers", async () => {
    const env = createEnv();
    const { applyAppMigration } = await deploymentsModule();

    await assert.rejects(
      () => applyAppMigration({
        appId: "app-1",
        version: "bad",
        sql: "CREATE TABLE IF NOT EXISTS sqlite_shadow (id TEXT PRIMARY KEY);"
      }, env, principal),
      (error) => error.status === 400 && error.code === "reserved_migration_identifier"
    );
  });

  it("requires App prefixes for every schema target and referenced table", async () => {
    const env = createEnv();
    const { applyAppMigration } = await deploymentsModule();

    for (const [version, sql] of [
      ["table-outside-prefix", "CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY);"],
      ["index-name-outside-prefix", "CREATE INDEX IF NOT EXISTS records_idx ON request_app_records(id);"],
      ["index-table-outside-prefix", "CREATE INDEX IF NOT EXISTS request_app_records_idx ON records(id);"],
      ["alter-outside-prefix", "ALTER TABLE records ADD COLUMN value TEXT;"],
      ["reference-outside-prefix", "CREATE TABLE IF NOT EXISTS request_app_children (parent_id TEXT REFERENCES parents(id));"]
    ]) {
      await assert.rejects(
        () => applyAppMigration({ appId: "app-1", version, sql }, env, principal),
        (error) => error.status === 400 && error.code === "migration_table_outside_app_prefix"
      );
    }
  });

  it("refuses to reconcile or execute a D1 migration through an unexpected provider", async () => {
    const env = createEnv();
    const { applyAppMigration } = await deploymentsModule();
    await env.APPS_DB
      .prepare("UPDATE apps_app_resources SET provider = 'unexpected-provider' WHERE id = 'res-db'")
      .run();

    await assert.rejects(
      () => applyAppMigration({
        appId: "app-1",
        version: "invalid-provider",
        sql: "CREATE TABLE IF NOT EXISTS request_app_records (id TEXT PRIMARY KEY);"
      }, env, principal),
      (error) => error.status === 409 && error.code === "d1_database_resource_provider_invalid"
    );
  });

  it("uses token structure instead of SQL-looking text inside literals and comments", async () => {
    const env = createEnv();
    const { applyAppMigration } = await deploymentsModule();
    const sql = `
      CREATE TABLE IF NOT EXISTS request_app_notes (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO request_app_notes (id, value) VALUES ('one', 'SELECT FROM DROP; WHERE -- text');
      UPDATE request_app_notes SET value = '/* WHERE */ SELECT' WHERE id = 'one';
    `;

    await withCloudflareD1Mock(env, async () => {
      const result = await applyAppMigration({
        allowDataMigrations: true,
        appId: "app-1",
        version: "literal-structure",
        sql
      }, env, principal);
      assert.equal(result.migration.impact.dataStatementCount, 2);
      const row = env.__cloudflareD1.prepare("SELECT value FROM request_app_notes WHERE id = 'one'").get();
      assert.equal(row.value, "/* WHERE */ SELECT");
    });
  });
});
