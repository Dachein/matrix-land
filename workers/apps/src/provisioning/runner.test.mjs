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

let runnerModulePromise;
let serviceModulePromise;

async function loadTsModule(entryPoint) {
  const outdir = await mkdtemp(join(tmpdir(), "apps-runtime-test-"));
  const outfile = join(outdir, `${entryPoint.replace(/[^a-z0-9]+/gi, "-")}.mjs`);
  await build({
    bundle: true,
    entryPoints: [new URL(entryPoint, import.meta.url).pathname],
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
  serviceModulePromise ??= loadTsModule("../apps/service.ts");
  return serviceModulePromise;
}

function runnerModule() {
  runnerModulePromise ??= loadTsModule("./runner.ts");
  return runnerModulePromise;
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
    for (const statement of statements) results.push(await statement.run());
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
    AUTH_WORKER_URL: "https://auth.example.test",
    DEV_AUTH_BYPASS: "1",
    WORKSPACE_AUTH_APP_SECRET: "shared-auth-app-secret",
    APPS_AUTH_SERVICE_TOKEN: "auth-service-token",
    APPS_BASE_DOMAIN: "example.invalid",
    PLATFORM_MCP_URL: "https://apps.example.invalid/mcp",
    APPS_DB: new D1Adapter(database),
    APPS_SECRET_ENCRYPTION_KEY: "generic-app-secret-encryption-key-32-plus"
  };
}

const principal = {
  email: "owner@example.test",
  orgId: "org-1",
  orgSlug: "workspace",
  scopes: ["apps:apps:write", "apps:deploy:production"],
  sub: "user-1"
};

function withUpstreamMocks(fn) {
  const originalFetch = globalThis.fetch;
  const state = {
    authCalls: [],
    authStatus: 201
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin === "https://auth.example.test" && url.pathname === "/v1/admin/apps") {
      state.authCalls.push({
        body: JSON.parse(String(init.body || "{}")),
        headers: new Headers(init.headers)
      });
      return new Response(JSON.stringify({ app: { status: "listed" } }), {
        headers: { "content-type": "application/json" },
        status: state.authStatus
      });
    }
    return new Response(JSON.stringify({ error: "unexpected_test_fetch" }), { status: 500 });
  };
  return Promise.resolve()
    .then(() => fn(state))
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

describe("APPS app provisioning", () => {
  it("registers selected Web storage and records only effective provisioning resources", async () => {
    const env = createEnv();
    const { createAppFromInput } = await serviceModule();
    const created = await createAppFromInput({
      code: "web-r2-storage",
      name: "Web R2 Storage",
      resourceTypes: ["worker", "d1_database", "r2_bucket"],
      type: "web",
      visibility: "org"
    }, env, principal);

    const resources = await env.APPS_DB
      .prepare("SELECT type, binding_name, status FROM apps_app_resources WHERE app_id = ? ORDER BY created_at")
      .bind(created.app.id)
      .all();
    assert.deepEqual(resources.results.map((resource) => resource.type).sort(), [
      "d1_database",
      "r2_bucket",
      "worker"
    ]);
    assert.equal(resources.results.find((resource) => resource.type === "r2_bucket")?.binding_name, "BUCKET");

    const storageStep = await env.APPS_DB
      .prepare("SELECT resource_type, status FROM apps_provisioning_steps WHERE job_id = ? AND step_key = 'create_storage'")
      .bind(created.provisioningJob.id)
      .first();
    assert.equal(storageStep.resource_type, "r2_bucket");
    assert.equal(storageStep.status, "queued");
  });

  it("provisions an App grant on the shared Stream service", async () => {
    const env = createEnv();
    env.WORKSPACE_STREAM = { fetch: async () => Response.json({ ok: true, capabilities: ["app-stream-v1"] }) };
    const { createAppFromInput } = await serviceModule();
    const { provisionResourceTypes } = await loadTsModule("./cloudflareResources.ts");
    const created = await createAppFromInput({
      code: "web-media",
      name: "Web Media",
      resourceTypes: ["media"],
      type: "web",
      visibility: "org"
    }, env, principal);

    const runtimeStep = await env.APPS_DB
      .prepare("SELECT resource_type FROM apps_provisioning_steps WHERE job_id = ? AND step_key = 'create_runtime'")
      .bind(created.provisioningJob.id)
      .first();
    assert.ok(runtimeStep.resource_type.split(",").includes("media"));

    const appRow = await env.APPS_DB.prepare("SELECT * FROM apps_apps WHERE id = ?").bind(created.app.id).first();
    await provisionResourceTypes(env, appRow, ["media"], new Date().toISOString(), { requireRegistered: true });
    const resource = await env.APPS_DB
      .prepare("SELECT binding_name, provider, status FROM apps_app_resources WHERE app_id = ? AND type = 'media'")
      .bind(created.app.id)
      .first();
    assert.equal(resource.binding_name, "WORKSPACE_STREAM");
    assert.equal(resource.provider, "workspace-stream");
    assert.equal(resource.status, "ready");
  });

  it("fails provisioning when a selected resource registry row disappears", async () => {
    const env = createEnv();
    const { createAppFromInput } = await serviceModule();
    const { runProvisioningJob } = await runnerModule();
    const created = await createAppFromInput({
      code: "missing-r2-registry",
      name: "Missing R2 Registry",
      resourceTypes: ["worker", "d1_database", "r2_bucket"],
      type: "web",
      visibility: "org"
    }, env, principal);
    await env.APPS_DB
      .prepare("DELETE FROM apps_provisioning_steps WHERE job_id = ? AND step_key != 'create_storage'")
      .bind(created.provisioningJob.id)
      .run();
    await env.APPS_DB
      .prepare("DELETE FROM apps_app_resources WHERE app_id = ? AND type = 'r2_bucket'")
      .bind(created.app.id)
      .run();

    await assert.rejects(
      () => runProvisioningJob(env, created.provisioningJob.id, { throwOnFailure: true }),
      (error) => error?.status === 409 && error?.code === "provisioning_resource_registry_missing"
    );
  });

  it("registers a generic authenticated App as draft and pending during provisioning", async () => {
    const env = createEnv();
    const { createAppFromInput } = await serviceModule();
    const { runProvisioningJob } = await runnerModule();
    const created = await createAppFromInput({
      code: "draft-auth-app",
      loginRequired: true,
      name: "Draft Auth App",
      resourceTypes: [],
      type: "web",
      visibility: "org"
    }, env, principal);
    await env.APPS_DB
      .prepare("DELETE FROM apps_provisioning_steps WHERE job_id = ? AND step_key != 'register_auth'")
      .bind(created.provisioningJob.id)
      .run();

    await withUpstreamMocks(async (state) => {
      await runProvisioningJob(env, created.provisioningJob.id, { throwOnFailure: true });

      assert.equal(state.authCalls.length, 1);
      const registration = state.authCalls[0].body;
      assert.equal(registration.id, created.app.id);
      assert.equal(registration.status, "draft");
      assert.equal(registration.sdkStatus, "pending");
      assert.equal(registration.accessMode, "targeted");
      assert.deepEqual(registration.accessTargets, []);
      assert.equal(registration.publisherUserId, principal.sub);
      assert.match(registration.appSecret, /^[0-9a-f]{64}$/);
    });

    const app = await env.APPS_DB
      .prepare("SELECT status FROM apps_apps WHERE id = ?")
      .bind(created.app.id)
      .first();
    assert.equal(app.status, "draft");
  });

});
