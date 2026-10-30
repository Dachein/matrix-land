import { testInstallation } from "../../../../tests/helpers/installation.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

let modulePromise;

async function loadWorkerModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-shared-origin-test-"));
  const outfile = join(outdir, "worker.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("../worker.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function workerModule() {
  modulePromise ??= loadWorkerModule();
  return modulePromise;
}

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

function createEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/apps/db/schema.sql", "utf8"));
  database.prepare(`
    INSERT INTO apps_apps (
      id, org_id, org_slug, owner_user_id, name, code, slug, description,
      type, status, visibility, login_required, agent_mcp_enabled, llm_enabled,
      data_service_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "app-private",
    "org-1",
    "workspace",
    "owner-1",
    "Private App",
    "private-app",
    "private-app",
    "",
    "web",
    "published",
    "team",
    1,
    0,
    0,
    "ds-private",
    "2026-07-16T00:00:00.000Z",
    "2026-07-16T00:00:00.000Z"
  );
  return { ...testInstallation,
    APPS_BASE_DOMAIN: "example.invalid",
    APPS_DB: new D1Adapter(database),
    PLATFORM_MCP_URL: "https://apps.example.invalid/mcp"
  };
}

const ctx = { waitUntil() {} };

describe("authenticated APPS shared-origin fallback", () => {
  it("redirects navigation to the App's independent origin before serving any App content", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const response = await handleAppsWorkerRequest(
      new Request("https://apps.example.invalid/run/private-app/"),
      createEnv(),
      ctx
    );

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://private-app.example.invalid/");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("does not redirect a state-changing shared-origin request", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const response = await handleAppsWorkerRequest(
      new Request("https://apps.example.invalid/run/private-app/api/update", { method: "POST" }),
      createEnv(),
      ctx
    );

    assert.equal(response.status, 421);
    assert.equal((await response.json()).error, "canonical_app_origin_required");
  });

  it("fails closed when legacy cross-organization rows collide on one canonical hostname", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const env = createEnv();
    await env.APPS_DB.prepare(`
      INSERT INTO apps_apps (
        id, org_id, org_slug, owner_user_id, name, code, slug, description,
        type, status, visibility, login_required, agent_mcp_enabled, llm_enabled,
        data_service_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      "app-private-other-org",
      "org-2",
      "other-org",
      "owner-2",
      "Colliding App",
      "private-app",
      "private-app",
      "",
      "web",
      "published",
      "team",
      1,
      0,
      0,
      "ds-other",
      "2026-07-16T01:00:00.000Z",
      "2026-07-16T01:00:00.000Z"
    ).run();

    const response = await handleAppsWorkerRequest(
      new Request("https://private-app.example.invalid/"),
      env,
      ctx
    );

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.match(await response.text(), /hostname is ambiguous/i);
  });
});


describe("enterprise App hostnames", () => {
  it("redirects to the configured root and app prefix without using the old installation", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const env = { ...createEnv(), APPS_BASE_DOMAIN: "enterprise.example", APPS_APP_HOST_PREFIX: "app-", PLATFORM_MCP_URL: "https://apps.enterprise.example/mcp" };
    const response = await handleAppsWorkerRequest(new Request("https://apps.enterprise.example/run/private-app/"), env, ctx);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://app-private-app.enterprise.example/");
  });
});
