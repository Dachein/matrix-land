import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import worker from "./index.ts";
import { createMiniappLoginTicket } from "./miniappAuth.ts";
import { upsertAuthUserSnapshot } from "./repository.ts";
import { signAuthToken, verifyAuthToken } from "./token.ts";

class D1Adapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1StatementAdapter(this.database.prepare(sql)); }
  async batch(statements) {
    const results = [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT"); return results;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}

class D1StatementAdapter {
  constructor(statement, params = []) { this.params = params; this.statement = statement; }
  bind(...params) { return new D1StatementAdapter(this.statement, params); }
  async all() { return { results: this.statement.all(...this.params), success: true }; }
  async first(columnName) { const row = this.statement.get(...this.params) ?? null; return columnName && row ? row[columnName] : row; }
  async run() { const result = this.statement.run(...this.params); return { meta: { changes: Number(result.changes ?? 0) }, success: true }; }
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/auth/db/schema.sql", "utf8"));
  database.prepare("UPDATE auth_login_email_policy SET allowed_domains_json = ? WHERE id = 1").run(JSON.stringify(["example.invalid"]));
  return {
    AUTH_DB: new D1Adapter(database),
    AUTH_ISSUER: "https://auth.example.test",
    AUTH_JWT_SECRET: "miniapp-test-jwt-secret-at-least-32-bytes",
    AUTH_PUBLIC_URL: "https://portal.example.test",
    WORKSPACE_ORG_ID: "example-org",
    WECHAT_MINIAPP_APP_ID: "wx1cdd0b65cea38eed",
    WECHAT_MINIAPP_APP_SECRET: "test-miniapp-secret"
  };
}

async function seed(env) {
  await upsertAuthUserSnapshot(env, {
    email: "miniapp.user@example.invalid",
    id: "user-miniapp",
    name: "Miniapp User",
    provider: "microsoft_entra_id",
    providerSubject: "entra-miniapp-user",
    role: "member",
    status: "active"
  });
  return signAuthToken(env, {
    typ: "workspace_session", sub: "user-miniapp", oid: "entra-miniapp-user",
    email: "miniapp.user@example.invalid", name: "Miniapp User",
    provider: "microsoft_entra_id", tid: "tenant-1", role: "member",
    exp: Math.floor(Date.now() / 1000) + 600
  });
}

it("exchanges a one-time scan ticket for a Workspace miniapp session", async () => {
  const env = fixture();
  env.WECHAT_MINIAPP_ENV_VERSION = "release";
  const session = await seed(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/cgi-bin/token")) return Response.json({ access_token: "wechat-access", expires_in: 7200 });
    if (url.includes("/wxa/getwxacodeunlimit")) {
      const body = JSON.parse(init?.body || "{}");
      assert.equal(body.page, "pages/login/index");
      assert.match(body.scene, /^[A-Za-z0-9_-]{20,80}$/);
      assert.equal(body.env_version, "release");
      assert.equal(body.check_path, false);
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "content-type": "image/png" } });
    }
    throw new Error(`unexpected_fetch:${url}`);
  };

  try {
    const ticketResponse = await worker.fetch(new Request("https://auth.example.test/auth/miniapp/login-tickets", {
      method: "POST", headers: { cookie: `workspace_session=${session}`, "content-type": "application/json" }, body: "{}"
    }), env);
    assert.equal(ticketResponse.status, 200);
    const loginTicket = await ticketResponse.json();
    assert.equal(loginTicket.qrImageDataUrl, "data:image/png;base64,iVBORw0KGgo=");
    assert.equal(ticketResponse.headers.get("cache-control"), "no-store");
    assert.match(loginTicket.ticket, /^[A-Za-z0-9_-]{20,80}$/);

    const scanned = await worker.fetch(new Request("https://auth.example.test/auth/miniapp/scan/prepare", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: loginTicket.ticket })
    }), env);
    assert.equal(scanned.status, 200);
    const identity = await scanned.json();
    assert.equal(identity.user.email, "miniapp.user@example.invalid");
    assert.equal((await worker.fetch(new Request(`https://auth.example.test/auth/miniapp/login-tickets/${encodeURIComponent(loginTicket.ticket)}/status`, {
      headers: { cookie: `workspace_session=${session}` }
    }), env).then((response) => response.json())).status, "scanned");

    const firstLogin = await worker.fetch(new Request("https://auth.example.test/auth/miniapp/scan/exchange", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: loginTicket.ticket })
    }), env);
    assert.equal(firstLogin.status, 200);
    const firstPayload = await firstLogin.json();
    assert.equal(firstPayload.authenticated, true);
    assert.equal(firstPayload.user.id, "user-miniapp");
    const cookie = firstLogin.headers.get("set-cookie");
    assert.match(cookie, /workspace_session=/);
    const token = cookie.match(/workspace_session=([^;]+)/)[1];
    assert.equal((await verifyAuthToken(env, token)).authenticationMethod, "miniapp_scan");

    const replay = await worker.fetch(new Request("https://auth.example.test/auth/miniapp/scan/exchange", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: loginTicket.ticket })
    }), env);
    assert.equal(replay.status, 410);
    assert.equal((await replay.json()).error, "miniapp_login_ticket_expired");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("rejects an unknown scan ticket", async () => {
  const env = fixture();
  const response = await worker.fetch(new Request("https://auth.example.test/auth/miniapp/scan/exchange", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: "unknown-ticket-1234567890" })
  }), env);
  assert.equal(response.status, 410);
  assert.equal((await response.json()).error, "miniapp_login_ticket_expired");
});

it("rejects WeChat JSON errors instead of showing them as a miniapp code", async () => {
  const env = fixture();
  const user = { id: "user-miniapp" };
  const fetcher = async (input) => String(input).includes("/cgi-bin/token")
    ? Response.json({ access_token: "wechat-access" })
    : Response.json({ errcode: 41030, errmsg: "invalid page" });
  await assert.rejects(createMiniappLoginTicket(env, user, fetcher), /invalid page/);
  const row = await env.AUTH_DB.prepare("SELECT COUNT(*) AS count FROM auth_miniapp_login_tickets").first();
  assert.equal(row.count, 0);
});

it("retires the standalone miniapp login pages while keeping ticket APIs", async () => {
  const env = fixture();
  const session = await seed(env);
  for (const path of ["/auth/miniapp/login", "/auth/miniapp/bind"]) {
    const response = await worker.fetch(new Request(`https://auth.example.test${path}`, {
      headers: { cookie: `workspace_session=${session}` }
    }), env);
    assert.equal(response.status, 404);
  }
});
