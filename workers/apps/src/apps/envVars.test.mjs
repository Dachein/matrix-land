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
  const outdir = await mkdtemp(join(tmpdir(), "apps-env-vars-test-"));
  const outfile = join(outdir, "envVars.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./envVars.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function envVarsModule() {
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "app-1",
    "org-1",
    "workspace",
    "user-1",
    "Request App",
    "request-app",
    "request-app",
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
  return { APPS_DB: new D1Adapter(database) };
}

const principal = {
  orgId: "org-1",
  orgSlug: "workspace",
  scopes: ["apps:apps:write"],
  sub: "user-1"
};

describe("APPS app env vars", () => {
  it("sets, lists, and deletes non-secret env vars", async () => {
    const env = createEnv();
    const { deleteAppEnvVars, listAppEnvVars, setAppEnvVars } = await envVarsModule();

    const setResult = await setAppEnvVars({
      appId: "app-1",
      target: "pages",
      vars: {
        FEATURE_FLAG: "on",
        WORKSPACE_AUTH_SESSION_ENDPOINT: "/api/auth/session"
      }
    }, env, principal);

    assert.equal(setResult.envVars.length, 2);
    const listed = await listAppEnvVars(env, principal, "app-1", "pages");
    assert.deepEqual(listed.envVars.map((item) => item.name), ["FEATURE_FLAG", "WORKSPACE_AUTH_SESSION_ENDPOINT"]);

    const afterDelete = await deleteAppEnvVars({
      appId: "app-1",
      names: ["FEATURE_FLAG"],
      target: "pages"
    }, env, principal);

    assert.deepEqual(afterDelete.envVars.map((item) => item.name), ["WORKSPACE_AUTH_SESSION_ENDPOINT"]);
  });

  it("rejects secret-looking names", async () => {
    const env = createEnv();
    const { setAppEnvVars } = await envVarsModule();

    await assert.rejects(
      () => setAppEnvVars({
        appId: "app-1",
        vars: { API_KEY: "secret-ish" }
      }, env, principal),
      (error) => error.status === 400 && error.code === "env_var_looks_like_secret"
    );
  });
});
