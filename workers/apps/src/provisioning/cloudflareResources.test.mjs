import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database.prepare(sql));
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

let modulePromise;

async function loadModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-provisioning-test-"));
  const outfile = join(outdir, "cloudflareResources.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./cloudflareResources.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function provisioningModule() {
  modulePromise ??= loadModule();
  return modulePromise;
}

function createEnv() {
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
    VALUES ('app-1', 'org-1', 'workspace', 'user-1', 'Real App', 'real-app', 'real-app', '', 'container', 'provisioning', 'org', 1, 1, 0, 'ds-1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
  `).run();
  for (const [id, type, provider, name, binding] of [
    ["res-d1", "d1_database", "cloudflare", "apps-real-app-db", "DB"],
    ["res-kv", "kv_namespace", "cloudflare", "apps-real-app-kv", "CONFIG"],
    ["res-r2", "r2_bucket", "cloudflare", "apps-real-app-r2", "BUCKET"],
    ["res-queue", "queue", "cloudflare", "apps-real-app-queue", "QUEUE"],
    ["res-pages", "pages_project", "cloudflare-pages", "apps-real-app-pages", ""],
    ["res-functions", "pages_function", "cloudflare-pages", "apps-real-app-functions", ""],
    ["res-worker", "worker", "cloudflare", "apps-real-app-worker", ""],
    ["res-schema", "schema_registry", "workspace-apps", "apps-real-app-schema", ""],
    ["res-cron", "cron_trigger", "cloudflare", "apps-real-app-cron", ""]
  ]) {
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
      VALUES (?, 'app-1', 'ds-1', ?, ?, ?, '', ?, 'prod', 'queued', '2026-07-01T00:00:00.000Z')
    `).run(id, type, provider, name, binding);
  }
  database.prepare("UPDATE apps_app_resources SET status = 'placeholder' WHERE id = 'res-cron'").run();

  const app = database.prepare("SELECT * FROM apps_apps WHERE id = 'app-1'").get();
  return {
    app,
    env: {
      CF_ACCOUNT_ID: "acct-1",
      CF_API_TOKEN: "cf-token",
      APPS_DB: new D1Adapter(database)
    }
  };
}

function withCloudflareProvisioningMock(fn) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "");
    const method = (init.method || "GET").toUpperCase();
    calls.push({ method, path, search: url.search });

    if (path === "/accounts/acct-1/d1/database" && method === "POST") {
      return jsonResponse({ name: "apps-real-app-db", uuid: "d1-created" });
    }
    if (path === "/accounts/acct-1/storage/kv/namespaces" && method === "POST") {
      return jsonResponse({ id: "kv-created", title: "apps-real-app-kv" });
    }
    if (path === "/accounts/acct-1/r2/buckets/apps-real-app-r2" && method === "GET") {
      return jsonResponse({}, 404);
    }
    if (path === "/accounts/acct-1/r2/buckets" && method === "POST") {
      return jsonResponse({ name: "apps-real-app-r2" });
    }
    if (path === "/accounts/acct-1/queues" && method === "GET") {
      return new Response(JSON.stringify({
        result: [],
        result_info: { page: 1, per_page: 1000, total_pages: 1 },
        success: true
      }), { headers: { "content-type": "application/json" } });
    }
    if (path === "/accounts/acct-1/queues" && method === "POST") {
      return jsonResponse({ queue_id: "queue-created", queue_name: "apps-real-app-queue" });
    }
    if (path === "/accounts/acct-1/pages/projects/apps-real-app-pages" && method === "GET") {
      return jsonResponse({}, 404);
    }
    if (path === "/accounts/acct-1/pages/projects" && method === "POST") {
      return jsonResponse({ id: "pages-created", name: "apps-real-app-pages" });
    }
    if (path === "/accounts/acct-1/workers/scripts/apps-real-app-worker" && method === "GET") {
      return jsonResponse({}, 404);
    }
    if (path === "/accounts/acct-1/workers/scripts/apps-real-app-worker" && method === "PUT") {
      return jsonResponse({ id: "worker-created" });
    }
    if (path === "/accounts/acct-1/d1/database" && method === "GET") {
      return jsonResponse([]);
    }
    if (path === "/accounts/acct-1/storage/kv/namespaces" && method === "GET") {
      return jsonResponse([]);
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

describe("Cloudflare resource provisioning", () => {
  it("creates independent Cloudflare resources and writes provider ids back to APPS", async () => {
    const { app, env } = createEnv();
    const { provisionResourceTypes } = await provisioningModule();

    await withCloudflareProvisioningMock(async (calls) => {
      await provisionResourceTypes(env, app, [
        "d1_database",
        "kv_namespace",
        "r2_bucket",
        "queue",
        "pages_project",
        "pages_function",
        "worker",
        "schema_registry",
        "cron_trigger"
      ], "2026-07-01T00:10:00.000Z");

      assert.ok(calls.some((call) => call.method === "POST" && call.path === "/accounts/acct-1/d1/database"));
      assert.ok(calls.some((call) => call.method === "POST" && call.path === "/accounts/acct-1/storage/kv/namespaces"));
      assert.ok(calls.some((call) => call.method === "POST" && call.path === "/accounts/acct-1/r2/buckets"));
      assert.ok(calls.some((call) => call.method === "POST" && call.path === "/accounts/acct-1/queues"));
      assert.ok(calls.some((call) => call.method === "POST" && call.path === "/accounts/acct-1/pages/projects"));
      assert.ok(calls.some((call) => call.method === "PUT" && call.path === "/accounts/acct-1/workers/scripts/apps-real-app-worker"));

      const resources = await env.APPS_DB.prepare("SELECT type, provider, resource_id, status FROM apps_app_resources WHERE app_id = ? ORDER BY type").bind("app-1").all();
      const byType = Object.fromEntries(resources.results.map((row) => [row.type, row]));
      assert.equal(byType.d1_database.resource_id, "d1-created");
      assert.equal(byType.kv_namespace.resource_id, "kv-created");
      assert.equal(byType.r2_bucket.resource_id, "apps-real-app-r2");
      assert.equal(byType.queue.resource_id, "queue-created");
      assert.equal(byType.queue.provider, "cloudflare-queues");
      assert.equal(byType.pages_project.resource_id, "pages-created");
      assert.equal(byType.pages_function.resource_id, "pages-created");
      assert.equal(byType.worker.resource_id, "apps-real-app-worker");
      assert.equal(byType.schema_registry.status, "ready");
      assert.equal(byType.cron_trigger.status, "placeholder");
    });
  });
});
