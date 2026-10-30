import { testInstallation } from "../../../../tests/helpers/installation.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import auth from "../index.ts";
import { signAuthToken } from "../token.ts";
import { upsertAuthUserSnapshot } from "../repositories/users/writes.ts";
import { withDefaultAgent } from "./defaultAgent.ts";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let appsWorkerPromise;
function appsWorker() {
  return appsWorkerPromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "default-agent-test-"));
    const outfile = join(directory, "apps.mjs");
    await build({ entryPoints: [new URL("../../../apps/src/worker.ts", import.meta.url).pathname],
      bundle: true, format: "esm", platform: "neutral", outfile, logLevel: "silent" });
    const mod = await import(pathToFileURL(outfile).href);
    await rm(directory, { recursive: true, force: true });
    return mod.handleAppsWorkerRequest;
  })();
}

class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    const bound = (values = []) => ({ bind: (...args) => bound(args),
      async first() { return stmt.get(...values) || null; }, async all() { return { results: stmt.all(...values) }; },
      async run() { return { meta: { changes: Number(stmt.run(...values).changes) } }; } });
    return bound();
  }
  async batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
}

async function fixture() {
  const handleAppsWorkerRequest = await appsWorker();
  const appsDb = new DatabaseSync(":memory:");
  appsDb.exec(`CREATE TABLE apps_mates (id TEXT,org_id TEXT,owner_user_id TEXT,work_email TEXT,display_name TEXT,is_default INTEGER,status TEXT,active_release_id TEXT);
    INSERT INTO apps_mates VALUES ('finance-assistant','org-1','user-1','receipts-assistant@example.invalid','小鲸',1,'published','r1'),
      ('foreign-mate','org-2','user-1','foreign@example.invalid','Foreign',1,'published','r2'),
      ('draft-mate','org-1','draft-user','draft@example.invalid','Draft',1,'draft',NULL);`);
  const appsEnv = { ...testInstallation, APPS_DB: new D1(appsDb), MATE_MCP_SERVICE_TOKEN: "mate-service-token" };
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  db.exec("UPDATE auth_login_email_policy SET mode='company_email_only',allowed_domains_json='[\"company.example\"]' WHERE id=1");
  const env = { ...testInstallation, AUTH_DB: new D1(db), AUTH_JWT_SECRET: "test-auth-secret", AUTH_ISSUER: "https://auth.test",
    AUTH_SERVICE_TOKEN: "auth-service-token", WORKSPACE_ORG_ID: "org-1", MATE_MCP_SERVICE_TOKEN: "mate-service-token",
    APPS_CONTROL_PLANE: { fetch: request => handleAppsWorkerRequest(request, appsEnv, { waitUntil() {} }) } };
  await upsertAuthUserSnapshot(env, { id: "user-1", name: "Ada", email: "ada@company.example", status: "active", role: "member" });
  return { env, appsEnv, appsDb };
}

test("Auth basic info resolves the default Agent's actual identity and refreshes changes", async () => {
  const { env, appsDb } = await fixture();
  const token = await signAuthToken(env, { typ: "workspace_session", sub: "user-1", oid: "user-1", email: "ada@company.example", exp: Date.now() / 1000 + 60 });
  const session = () => auth.fetch(new Request("https://auth.test/auth/session", { headers: { cookie: `workspace_session=${token}` } }), env);
  let payload = await (await session()).json();
  assert.equal(payload.authenticated, true);
  assert.deepEqual(payload.user.defaultAgent, { id: "finance-assistant", name: "小鲸", email: "receipts-assistant@example.invalid" });
  appsDb.exec("UPDATE apps_mates SET display_name='小蓝',work_email='blue@mate.example.invalid' WHERE id='finance-assistant'");
  payload = await (await session()).json();
  assert.equal(payload.user.defaultAgent.name, "小蓝");
  assert.equal(payload.user.defaultAgent.email, "blue@mate.example.invalid");
  const basic = await auth.fetch(new Request("https://auth.test/v1/session", { headers: {
    authorization: "Bearer auth-service-token", "x-workspace-user-id": "user-1", "x-workspace-user-email": "ada@company.example"
  } }), env);
  assert.equal((await basic.json()).user.defaultAgent.email, "blue@mate.example.invalid");
});

test("no default Agent, draft, archived and another organization all return null", async () => {
  const { env, appsDb } = await fixture();
  for (const id of ["missing", "draft-user"]) assert.equal((await withDefaultAgent(env, { id })).defaultAgent, null);
  assert.equal((await withDefaultAgent({ ...env, WORKSPACE_ORG_ID: "org-3" }, { id: "user-1" })).defaultAgent, null);
  appsDb.exec("UPDATE apps_mates SET status='archived' WHERE id='finance-assistant'");
  assert.equal((await withDefaultAgent(env, { id: "user-1" })).defaultAgent, null);
});

test("default-Agent lookup authenticates the service and ignores caller-supplied profile fields", async () => {
  const { env, appsEnv } = await fixture();
  const handleAppsWorkerRequest = await appsWorker();
  const denied = await handleAppsWorkerRequest(new Request("https://apps.internal/internal/auth/default-agent", {
    headers: { "x-workspace-runtime-user-id": "user-1", "x-workspace-runtime-org-id": "org-1" }
  }), appsEnv, {});
  assert.equal(denied.status, 401);
  const result = await withDefaultAgent(env, { id: "missing", defaultAgent: { id: "fake", name: "fake", email: "fake@example.com" } });
  assert.equal(result.defaultAgent, null);
});

test("an unavailable optional Agent projection does not break authentication", async () => {
  const { env } = await fixture();
  const result = await withDefaultAgent({ ...env, APPS_CONTROL_PLANE: { async fetch() { throw Error("unavailable"); } } }, { id: "user-1", name: "Ada" });
  assert.equal(result.name, "Ada");
  assert.equal(result.defaultAgent, null);
});
