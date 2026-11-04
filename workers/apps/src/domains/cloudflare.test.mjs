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

let modulePromise;

async function loadModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-domains-test-"));
  const outfile = join(outdir, "cloudflare.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./cloudflare.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function domainModule() {
  modulePromise ??= loadModule();
  return modulePromise;
}

function createEnv({ appId, appType, hostname, resources }) {
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
    VALUES (?, 'org-1', 'workspace', 'user-1', 'Domain App', ?, ?, '', ?, 'provisioning', 'org', 1, 0, 0, 'ds-1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
  `).run(appId, hostname.split(".")[0], hostname.split(".")[0], appType);
  database.prepare(`
    INSERT INTO apps_domains (
      id,
      app_id,
      hostname,
      type,
      environment,
      status,
      fallback_url,
      created_at
    )
    VALUES ('dom-1', ?, ?, 'production', 'production', 'reserved', 'https://apps.example.invalid/run/app', '2026-07-01T00:00:00.000Z')
  `).run(appId, hostname);

  for (const resource of resources) {
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
      VALUES (?, ?, 'ds-1', ?, ?, ?, ?, '', 'prod', 'ready', '2026-07-01T00:00:00.000Z')
    `).run(resource.id, appId, resource.type, resource.provider, resource.name, resource.resourceId);
  }

  return {
    database,
    env: {
      CF_ACCOUNT_ID: "acct-1",
      CF_API_TOKEN: "cf-token",
      CF_ZONE_ID: "zone-1",
      APPS_DB: new D1Adapter(database)
    }
  };
}

function withCloudflareMock(handler, fn) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = `${url.pathname.replace("/client/v4", "")}${url.search}`;
    const method = (init.method || "GET").toUpperCase();
    const call = { body: init.body, method, path };
    calls.push(call);
    return handler(call);
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

describe("Cloudflare app domain provisioning", () => {
  it("binds a Pages app to a Pages custom domain", async () => {
    const hostname = "request-app.example.invalid";
    const { database, env } = createEnv({
      appId: "app-pages",
      appType: "web",
      hostname,
      resources: [
        {
          id: "res-pages",
          name: "apps-request-app-pages",
          provider: "cloudflare-pages",
          resourceId: "pages-real-1",
          type: "pages_project"
        }
      ]
    });
    const { ensurePublishedAppDomain } = await domainModule();

    await withCloudflareMock((call) => {
      if (call.path === `/zones/zone-1/dns_records?type=CNAME&name=${hostname}&per_page=10` && call.method === "GET") {
        return jsonResponse([]);
      }
      if (call.path === "/zones/zone-1/dns_records" && call.method === "POST") {
        return jsonResponse({ id: "dns-pages-1", name: hostname, type: "CNAME", content: "apps-request-app-pages.pages.dev", proxied: true });
      }
      if (call.path === `/accounts/acct-1/pages/projects/apps-request-app-pages/domains/${hostname}` && call.method === "GET") {
        return jsonResponse({}, 404);
      }
      if (call.path === "/accounts/acct-1/pages/projects/apps-request-app-pages/domains" && call.method === "POST") {
        return jsonResponse({ id: "domain-pages-1", name: hostname, status: "active", verification_data: { status: "active" } });
      }
      if (call.path === "/zones/zone-1/workers/routes?per_page=100" && call.method === "GET") {
        return jsonResponse([]);
      }
      if (call.path === "/zones/zone-1/workers/routes" && call.method === "POST") {
        return jsonResponse({ id: "route-pages-bypass-1", pattern: `${hostname}/*`, script: null });
      }
      return jsonResponse({ path: call.path, method: call.method }, 404);
    }, async (calls) => {
      const runtime = await ensurePublishedAppDomain(env, "app-pages");

      assert.ok(calls.some((call) => call.method === "POST" && call.path === "/accounts/acct-1/pages/projects/apps-request-app-pages/domains"));
      const bypassCall = calls.find((call) => call.method === "POST" && call.path === "/zones/zone-1/workers/routes");
      assert.ok(bypassCall);
      assert.deepEqual(JSON.parse(String(bypassCall.body)), { pattern: `${hostname}/*`, script: null });
      assert.equal(runtime.provider, "cloudflare-pages");
      const row = database.prepare("SELECT * FROM apps_domains WHERE app_id = 'app-pages'").get();
      assert.equal(row.provider, "cloudflare-pages");
      assert.equal(row.provider_resource_id, "domain-pages-1");
      assert.equal(row.dns_record_id, "dns-pages-1");
      assert.equal(row.route_id, "route-pages-bypass-1");
      assert.equal(row.route_status, "active");
      assert.equal(row.status, "active");
    });
  });

  it("binds a Worker app to an app-specific Worker route", async () => {
    const hostname = "agent-app.example.invalid";
    const { database, env } = createEnv({
      appId: "app-worker",
      appType: "agent_app",
      hostname,
      resources: [
        {
          id: "res-worker",
          name: "apps-agent-app-worker",
          provider: "cloudflare-workers",
          resourceId: "apps-agent-app-worker",
          type: "worker"
        }
      ]
    });
    const { ensurePublishedAppDomain } = await domainModule();

    await withCloudflareMock((call) => {
      if (call.path === `/zones/zone-1/dns_records?type=AAAA&name=${hostname}&per_page=10` && call.method === "GET") {
        return jsonResponse([]);
      }
      if (call.path === "/zones/zone-1/dns_records" && call.method === "POST") {
        return jsonResponse({ id: "dns-worker-1", name: hostname, type: "AAAA", content: "100::", proxied: true });
      }
      if (call.path === "/zones/zone-1/workers/routes?per_page=100" && call.method === "GET") {
        return jsonResponse([]);
      }
      if (call.path === "/zones/zone-1/workers/routes" && call.method === "POST") {
        return jsonResponse({ id: "route-worker-1", pattern: `${hostname}/*`, script: "apps-agent-app-worker" });
      }
      return jsonResponse({ path: call.path, method: call.method }, 404);
    }, async (calls) => {
      const runtime = await ensurePublishedAppDomain(env, "app-worker");

      assert.ok(calls.some((call) => call.method === "POST" && call.path === "/zones/zone-1/workers/routes"));
      assert.equal(calls.filter((call) => call.path === "/zones/zone-1/workers/routes?per_page=100").length, 1);
      assert.equal(runtime.provider, "cloudflare-workers");
      const row = database.prepare("SELECT * FROM apps_domains WHERE app_id = 'app-worker'").get();
      assert.equal(row.provider, "cloudflare-workers");
      assert.equal(row.provider_resource_id, "apps-agent-app-worker");
      assert.equal(row.dns_record_id, "dns-worker-1");
      assert.equal(row.route_id, "route-worker-1");
      assert.equal(row.route_status, "active");
      assert.equal(row.status, "active");
    });
  });

  it("does not mark a Pages domain active when the wildcard bypass fails", async () => {
    const hostname = "failed-pages.example.invalid";
    const { database, env } = createEnv({
      appId: "app-pages-failed",
      appType: "static_page",
      hostname,
      resources: [{
        id: "res-pages-failed",
        name: "apps-failed-pages",
        provider: "cloudflare-pages",
        resourceId: "pages-failed-1",
        type: "pages_project"
      }]
    });
    const { ensurePublishedAppDomain } = await domainModule();

    await withCloudflareMock((call) => {
      if (call.path === `/zones/zone-1/dns_records?type=CNAME&name=${hostname}&per_page=10`) {
        return jsonResponse([{ id: "dns-pages-failed", name: hostname, type: "CNAME", content: "apps-failed-pages.pages.dev", proxied: true }]);
      }
      if (call.path === `/accounts/acct-1/pages/projects/apps-failed-pages/domains/${hostname}`) {
        return jsonResponse({ id: "domain-pages-failed", name: hostname, status: "active", verification_data: { status: "active" } });
      }
      if (call.path === "/zones/zone-1/workers/routes?per_page=100") {
        return jsonResponse([]);
      }
      if (call.path === "/zones/zone-1/workers/routes" && call.method === "POST") {
        return jsonResponse({ errors: [{ code: 10000, message: "route denied" }] }, 500);
      }
      return jsonResponse({ path: call.path, method: call.method }, 404);
    }, async () => {
      await assert.rejects(() => ensurePublishedAppDomain(env, "app-pages-failed"));
    });

    const row = database.prepare("SELECT * FROM apps_domains WHERE app_id = 'app-pages-failed'").get();
    assert.equal(row.status, "reserved");
    assert.equal(row.route_status, "failed");
    assert.equal(row.error_code, "cloudflare_provisioning_failed");
    assert.match(row.error_message, /route denied|cloudflare/i);
  });
});
