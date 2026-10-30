import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import worker from "./index.ts";
import { signAuthToken, signMcpAccessToken, verifyMcpAccessToken } from "./token.ts";

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database.prepare(sql), [], sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

class D1StatementAdapter {
  constructor(statement, params = [], sql = "") {
    this.params = params;
    this.sql = sql;
    this.statement = statement;
  }

  bind(...params) {
    return new D1StatementAdapter(this.statement, params, this.sql);
  }

  async all() {
    return { results: this.statement.all(...this.params) };
  }

  async first() {
    return this.statement.get(...this.params) ?? null;
  }

  async run() {
    if (/\bRETURNING\b/i.test(this.sql)) {
      return { results: this.statement.all(...this.params), success: true };
    }
    this.statement.run(...this.params);
    return { results: [], success: true };
  }
}

function createAuthDb() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/auth/db/schema.sql", "utf8"));
  return new D1Adapter(database);
}

function createEnv() {
  return {
    AUTH_DB: createAuthDb(),
    MCP_RESOURCE_URL: "https://mcp.example.invalid",
    AUTH_ISSUER: "https://auth.workspace.internal",
    AUTH_JWT_SECRET: "test-secret",
    MCP_ACCESS_JWT_SECRET: "mcp-access-test-secret",
    AUTH_RESOURCE_INTROSPECTION_TOKEN: "introspect-token",
    AUTH_SERVICE_TOKEN: "service-token",
    ENTRA_TENANT_ID: "entra-tenant-guid",
    WORKSPACE_ORG_ID: "org-workspace",
    RESOURCE_TOKEN_TTL_SECONDS: "120"
  };
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

async function registerResource(env, overrides = {}) {
  const response = await worker.fetch(new Request("https://auth.test/v1/admin/resources", {
    method: "POST",
    headers: {
      authorization: "Bearer service-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      id: "resource-funds",
      name: "Fund Query API",
      status: "listed",
      audience: "https://api.funds.example.com",
      accessMode: "targeted",
      accessTargets: ["department:dept-investment"],
      allowedScopes: ["funds:read"],
      ...overrides
    })
  }), env);

  assert.equal(response.status, 201);
  return readJson(response);
}

async function registerApp(env, overrides = {}) {
  const response = await worker.fetch(new Request("https://auth.test/v1/admin/apps", {
    method: "POST",
    headers: {
      authorization: "Bearer service-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      id: "app-academy",
      name: "Academy",
      status: "listed",
      sdkStatus: "connected",
      accessMode: "public",
      callbackUrls: ["https://academy.example.com/auth/workspace/callback"],
      launchUrl: "https://academy.example.com",
      appSecret: "academy-test-client-secret-at-least-32",
      ...overrides
    })
  }), env);

  assert.equal(response.status, 201);
}

async function insertAuthUser(env, overrides = {}) {
  const user = {
    id: "user-1",
    email: "test.user@example.invalid",
    name: "Ada Zhang",
    role: "member",
    status: "active",
    departmentId: "dept-research",
    departmentPath: ["company", "dept-investment", "dept-research"],
    teamId: "team-market-data",
    teamPath: ["company", "dept-investment", "team-market-data"],
    ...overrides
  };

  await env.AUTH_DB
    .prepare(
      `
      INSERT INTO auth_users (
        id, email, name, role, status,
        department_id, department_path_json, team_id, team_path_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      user.id,
      user.email,
      user.name,
      user.role,
      user.status,
      user.departmentId ?? null,
      JSON.stringify(user.departmentPath),
      user.teamId ?? null,
      JSON.stringify(user.teamPath)
    )
    .run();

  return user;
}

async function insertMcpConnection(env, overrides = {}) {
  const connection = {
    clientId: "workspace-ai-mcp",
    id: "conn-current",
    lastSeenAt: "2020-01-01 00:00:00",
    status: "active",
    userId: "user-mcp",
    ...overrides
  };

  await env.AUTH_DB
    .prepare("INSERT OR IGNORE INTO auth_users (id, name, role, status) VALUES (?, 'MCP User', 'member', 'active')")
    .bind(connection.userId)
    .run();
  await env.AUTH_DB
    .prepare(
      "INSERT OR IGNORE INTO auth_mcp_clients (id, name, status, resource_url, allowed_scopes_json) VALUES (?, 'Workspace MCP', 'active', ?, ?)"
    )
    .bind(
      connection.clientId,
      "https://mcp.example.invalid",
      JSON.stringify(["workspace:knowledge:read"])
    )
    .run();
  await env.AUTH_DB
    .prepare(
      `
      INSERT INTO auth_mcp_connections (
        id, client_id, user_id, agent_type, display_name, resource_url,
        scopes_json, status, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'codex', 'Codex', ?, ?, ?, ?, '2020-01-01 00:00:00', '2020-01-01 00:00:00')
      `
    )
    .bind(
      connection.id,
      connection.clientId,
      connection.userId,
      "https://mcp.example.invalid",
      JSON.stringify(["workspace:knowledge:read"]),
      connection.status,
      connection.lastSeenAt
    )
    .run();

  return connection;
}

async function createMcpToken(env, overrides = {}) {
  return signMcpAccessToken(env, {
    typ: "mcp_access",
    iss: "https://auth.workspace.internal",
    aud: "workspace-mcp",
    sub: "user-mcp",
    org_id: "org-workspace",
    client_id: "workspace-ai-mcp",
    connection_id: "conn-current",
    department_id: "dept-stale",
    department_path: ["company", "dept-stale"],
    team_id: "team-stale",
    team_path: ["company", "team-stale"],
    scopes: ["workspace:knowledge:read"],
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides
  });
}

async function introspectMcpToken(env, token) {
  const response = await worker.fetch(new Request("https://auth.test/v1/mcp/tokens/introspect", {
    method: "POST",
    headers: {
      authorization: "Bearer service-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({ token })
  }), env);

  return { payload: await readJson(response), response };
}

describe("resource token endpoints", () => {
  it("retires every public MCP device-flow endpoint with an OAuth handoff", async () => {
    const env = createEnv();
    for (const path of ["code", "approve", "inspect", "deny", "token", "verify"]) {
      const response = await worker.fetch(new Request(`https://auth.test/v1/mcp/device/${path}`, {
        method: path === "verify" ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        body: path === "verify" ? undefined : "{}"
      }), env);
      const payload = await readJson(response);
      assert.equal(response.status, 410);
      assert.equal(payload.error, "mcp_oauth_required");
      assert.equal(payload.handoff.state, "reauthorization_required");
      assert.equal(payload.handoff.nextAction.kind, "oauth_login");
      assert.equal(payload.handoff.nextAction.requiresUserApproval, true);
      assert.doesNotMatch(JSON.stringify(payload), /device_code|Bearer <|access_token/);
    }
  });

  it("restricts device grants even when another Agent client is registered for browser OAuth", async () => {
    const env = createEnv();
    const registration = await worker.fetch(new Request("https://auth.test/v1/mcp/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_type: "codex", client_name: "Codex", redirect_uris: ["http://127.0.0.1:49152/callback"] })
    }), env);
    assert.equal(registration.status, 201);
    const client = await readJson(registration);
    assert.deepEqual(client.grant_types, ["authorization_code", "refresh_token"]);
    const creation = await worker.fetch(new Request("https://auth.test/v1/mcp/oauth/device_authorization", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id })
    }), env);
    assert.equal(creation.status, 401);
    assert.equal((await readJson(creation)).error, "invalid_client");
    const exchange = await worker.fetch(new Request("https://auth.test/v1/mcp/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "unissued-device-code" })
    }), env);
    assert.equal(exchange.status, 400);
    assert.equal((await readJson(exchange)).error, "unsupported_grant_type");
  });

  it("supports WorkBuddy CLI device authorization with rotating OAuth credentials", async () => {
    const env = { ...createEnv(), AUTH_PUBLIC_URL: "https://ai.example.invalid" };
    const user = await insertAuthUser(env, { id: "user-device", email: "device@example.invalid", name: "Device User" });
    const deviceResponse = await worker.fetch(new Request("https://auth.workspace.internal/v1/mcp/oauth/device_authorization", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "workspace-cli-workbuddy",
        resource: "https://mcp.example.invalid/mcp",
        scope: "workspace:forum:read workspace:hub:read"
      })
    }), env);
    assert.equal(deviceResponse.status, 200);
    const device = await readJson(deviceResponse);
    assert.match(device.device_code, /^[0-9a-f-]{36}$/);
    assert.match(device.user_code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(device.verification_uri, "https://ai.example.invalid/auth/mcp/device/verify");

    const exchange = () => worker.fetch(new Request("https://auth.workspace.internal/v1/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "workspace-cli-workbuddy",
        device_code: device.device_code
      })
    }), env);
    const pendingResponse = await exchange();
    assert.equal(pendingResponse.status, 400);
    assert.equal((await readJson(pendingResponse)).error, "authorization_pending");

    const session = await signAuthToken(env, {
      typ: "workspace_session",
      sub: user.id,
      oid: user.id,
      email: user.email,
      name: user.name,
      role: "member",
      exp: Math.floor(Date.now() / 1000) + 600
    });
    const consentResponse = await worker.fetch(new Request(device.verification_uri_complete, {
      headers: { cookie: `workspace_session=${session}` }
    }), env);
    assert.equal(consentResponse.status, 200);
    const consent = await consentResponse.text();
    assert.match(consent, /Workspace CLI for WorkBuddy/);
    const requestToken = consent.match(/name="request_token" value="([^"]+)"/)?.[1];
    assert.ok(requestToken);

    const approvalResponse = await worker.fetch(new Request("https://ai.example.invalid/auth/mcp/device/verify", {
      method: "POST",
      headers: { cookie: `workspace_session=${session}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_token: requestToken, decision: "approve" })
    }), env);
    assert.equal(approvalResponse.status, 200);
    assert.match(await approvalResponse.text(), /连接已完成/);

    const tokenResponse = await exchange();
    assert.equal(tokenResponse.status, 200);
    const token = await readJson(tokenResponse);
    assert.match(token.access_token, /^[^.]+\.[^.]+\.[^.]+$/);
    assert.match(token.refresh_token, /^fmr_/);
    const refreshResponse = await worker.fetch(new Request("https://auth.workspace.internal/v1/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: "workspace-cli-workbuddy", refresh_token: token.refresh_token })
    }), env);
    assert.equal(refreshResponse.status, 200);
    const refreshed = await readJson(refreshResponse);
    assert.notEqual(refreshed.refresh_token, token.refresh_token);
  });

  it("publishes agent-neutral MCP OAuth discovery and rotates persistent credentials", async () => {
    const env = {
      ...createEnv(),
      AUTH_PUBLIC_URL: "https://ai.example.invalid",
      MCP_ACCESS_TOKEN_TTL_SECONDS: "3600",
      MCP_IDLE_TTL_SECONDS: "604800"
    };
    const user = await insertAuthUser(env, {
      id: "user-oauth",
      email: "oauth@example.invalid",
      name: "OAuth User",
      departmentId: undefined,
      departmentPath: [],
      teamId: undefined,
      teamPath: []
    });

    const discoveryResponse = await worker.fetch(new Request("https://auth.workspace.internal/.well-known/oauth-authorization-server"), env);
    const discovery = await readJson(discoveryResponse);
    assert.equal(discovery.authorization_endpoint, "https://ai.example.invalid/auth/mcp/oauth/authorize");
    assert.equal(discovery.token_endpoint, "https://auth.workspace.internal/v1/mcp/oauth/token");
    assert.deepEqual(discovery.code_challenge_methods_supported, ["S256"]);
    assert.ok(discovery.scopes_supported.includes("workspace:hub:read"));
    assert.equal(discovery.scopes_supported.includes("workspace:market:read"), false);

    const unsafeRegistrationResponse = await worker.fetch(new Request("https://auth.workspace.internal/v1/mcp/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Untrusted", redirect_uris: ["https://attacker.example/callback"] })
    }), env);
    assert.equal(unsafeRegistrationResponse.status, 400);
    const unsafeRegistration = await readJson(unsafeRegistrationResponse);
    assert.equal(unsafeRegistration.error, "invalid_redirect_uri");
    assert.match(unsafeRegistration.error_description, /redirect_uri/);

    const redirectUri = "workbuddy://workbuddy/mcp/custom-mcp%3Aworkspace-ai/oauth/callback";
    const registrationResponse = await worker.fetch(new Request("https://auth.workspace.internal/v1/mcp/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Tencent WorkBuddy", redirect_uris: [redirectUri] })
    }), env);
    assert.equal(registrationResponse.status, 201);
    const registration = await readJson(registrationResponse);
    assert.match(registration.client_id, /^mcp-oauth-/);
    assert.equal(registration.token_endpoint_auth_method, "none");
    assert.equal(registration.agent_type, "workbuddy");

    for (const unsupportedWorkbuddyRedirectUri of [
      "workbuddy-ai://workbuddy/mcp/custom-mcp%3Aworkspace-ai/oauth/callback",
      "workbuddy://attacker/mcp/custom-mcp%3Aworkspace-ai/oauth/callback",
      "workbuddy-ai://attacker/mcp/custom-mcp%3Aworkspace-ai/oauth/callback",
      "workbuddy://workbuddy/mcp/custom-mcp%3Aworkspace-ai/not-oauth/callback",
      "workbuddy-ai://workbuddy/mcp/custom-mcp%3Aworkspace-ai/not-oauth/callback",
      "workbuddy-ai://workbuddy/mcp/custom-mcp%3Aworkspace-ai/oauth/callback#fragment",
      "workbuddy://workbuddy/mcp/custom-mcp%3Aworkspace-ai/oauth/callback?unexpected=1"
    ]) {
      const response = await worker.fetch(new Request("https://auth.workspace.internal/v1/mcp/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "WorkBuddy", redirect_uris: [unsupportedWorkbuddyRedirectUri] })
      }), env);
      assert.equal(response.status, 400);
      const payload = await readJson(response);
      assert.equal(payload.error, "invalid_redirect_uri");
      assert.match(payload.error_description, /redirect_uri/);
    }

    for (const [clientName, agentType] of [
      ["Claude Code", "claude-code"],
      ["Codex", "codex"]
    ]) {
      const loopbackRedirectUri = "http://127.0.0.1:49152/callback";
      const response = await worker.fetch(new Request("https://auth.workspace.internal/v1/mcp/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: clientName, redirect_uris: [loopbackRedirectUri] })
      }), env);
      assert.equal(response.status, 201);
      assert.equal((await readJson(response)).agent_type, agentType);
    }

    const workBuddyCliLoopbackUri = "http://127.0.0.1:51483/oauth/callback/workspace-cli-test";
    const workBuddyCliRegistrationResponse = await worker.fetch(new Request("https://auth.workspace.internal/v1/mcp/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "workspace-cli/0.4.2 WorkBuddy" },
      body: JSON.stringify({
        agent_type: "workbuddy",
        client_name: "Workspace CLI for WorkBuddy",
        redirect_uris: [workBuddyCliLoopbackUri],
        token_endpoint_auth_method: "none"
      })
    }), env);
    assert.equal(workBuddyCliRegistrationResponse.status, 201);
    const workBuddyCliRegistration = await readJson(workBuddyCliRegistrationResponse);
    assert.equal(workBuddyCliRegistration.agent_type, "workbuddy");
    assert.deepEqual(workBuddyCliRegistration.redirect_uris, [workBuddyCliLoopbackUri]);
    assert.deepEqual(workBuddyCliRegistration.grant_types, ["authorization_code", "refresh_token"]);

    const cursorRedirectUris = [
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "https://www.cursor.com/agents/mcp/oauth/callback",
      "http://localhost:8787/callback"
    ];
    const cursorRegistrationResponse = await worker.fetch(new Request("https://auth.workspace.internal/v1/mcp/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Cursor", redirect_uris: cursorRedirectUris })
    }), env);
    assert.equal(cursorRegistrationResponse.status, 201);
    const cursorRegistration = await readJson(cursorRegistrationResponse);
    assert.equal(cursorRegistration.agent_type, "cursor");
    assert.deepEqual(cursorRegistration.redirect_uris, cursorRedirectUris);

    const invalidAgentResponse = await worker.fetch(new Request("https://auth.workspace.internal/v1/mcp/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Unknown", agent_type: "unsupported", redirect_uris: ["http://127.0.0.1:49152/callback"] })
    }), env);
    assert.equal(invalidAgentResponse.status, 400);
    assert.equal((await readJson(invalidAgentResponse)).error, "invalid_client_metadata");

    const verifier = "workbuddy-pkce-verifier-that-is-long-enough-for-the-oauth-test-123";
    const challenge = await pkceChallenge(verifier);
    const session = await signAuthToken(env, {
      typ: "workspace_session",
      sub: user.id,
      oid: user.id,
      email: user.email,
      name: user.name,
      role: "member",
      exp: Math.floor(Date.now() / 1000) + 600
    });
    const authorizeUrl = new URL("https://ai.example.invalid/auth/mcp/oauth/authorize");
    authorizeUrl.search = new URLSearchParams({
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "https://mcp.example.invalid/mcp",
      scope: "workspace:forum:read workspace:apps:read",
      state: "workbuddy-state"
    }).toString();
    const consentResponse = await worker.fetch(new Request(authorizeUrl, {
      headers: { cookie: `workspace_session=${session}` }
    }), env);
    assert.equal(consentResponse.status, 200);
    const consentPolicy = consentResponse.headers.get("content-security-policy");
    assert.match(consentPolicy, /form-action 'self' workbuddy:/);
    assert.doesNotMatch(consentPolicy, /attacker\.example/);

    const consentHtml = await consentResponse.text();
    assert.match(consentHtml, /Frontier Workspace Playground/);
    assert.match(consentHtml, /统一能力范围/);
    assert.match(consentHtml, /Forum/);
    assert.match(consentHtml, /Hub/);
    assert.match(consentHtml, /APPS/);
    assert.match(consentHtml, /Knowledge/);
    assert.match(consentHtml, /连续 7 天未使用后自动失效/);
    assert.doesNotMatch(consentHtml, /workspace:forum:read/);
    const requestToken = consentHtml.match(/name="request_token" value="([^"]+)"/)?.[1];
    assert.ok(requestToken);

    const approvalResponse = await worker.fetch(new Request("https://ai.example.invalid/auth/mcp/oauth/authorize", {
      method: "POST",
      headers: {
        cookie: `workspace_session=${session}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ request_token: requestToken, decision: "approve" })
    }), env);
    assert.equal(approvalResponse.status, 200);
    assert.equal(approvalResponse.headers.get("cache-control"), "no-store");
    const callbackPage = await approvalResponse.text();
    assert.match(callbackPage, /Workspace MCP 已授权/);
    assert.match(callbackPage, /打开 WorkBuddy/);
    assert.match(approvalResponse.headers.get("content-security-policy"), /script-src 'nonce-[a-f0-9]+'/);
    const callbackHref = callbackPage.match(/id="open-workbuddy" href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
    assert.ok(callbackHref);
    const callback = new URL(callbackHref);
    assert.equal(callback.protocol, "workbuddy:");
    assert.equal(callback.hostname, "workbuddy");
    assert.equal(callback.pathname, "/mcp/custom-mcp%3Aworkspace-ai/oauth/callback");
    assert.equal(callback.searchParams.get("state"), "workbuddy-state");
    assert.ok(callback.searchParams.get("code"));

    const exchange = (body) => worker.fetch(new Request("https://auth.workspace.internal/v1/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body)
    }), env);
    const invalidVerifierResponse = await exchange({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      code: callback.searchParams.get("code"),
      code_verifier: `${verifier}-wrong`
    });
    assert.equal(invalidVerifierResponse.status, 400);
    assert.equal((await readJson(invalidVerifierResponse)).error, "invalid_grant");

    const tokenResponse = await exchange({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      code: callback.searchParams.get("code"),
      code_verifier: verifier
    });
    assert.equal(tokenResponse.status, 200);
    const first = await readJson(tokenResponse);
    assert.equal(first.expires_in, 3600);
    assert.match(first.access_token, /^[^.]+\.[^.]+\.[^.]+$/);
    assert.match(first.refresh_token, /^fmr_/);

    const firstRefreshResponse = await exchange({
      grant_type: "refresh_token",
      client_id: registration.client_id,
      refresh_token: first.refresh_token
    });
    assert.equal(firstRefreshResponse.status, 200);
    const second = await readJson(firstRefreshResponse);
    assert.notEqual(second.access_token, first.access_token);
    assert.notEqual(second.refresh_token, first.refresh_token);

    const replayResponse = await exchange({
      grant_type: "refresh_token",
      client_id: registration.client_id,
      refresh_token: first.refresh_token
    });
    assert.equal(replayResponse.status, 400);
    assert.equal((await readJson(replayResponse)).error, "invalid_grant");

    // There is no refresh-token-family absolute deadline: every successful use
    // rotates the credential and reopens the 7-day idle window. Repeating more
    // than the legacy 30-day access-token horizon exercises that contract.
    let current = second;
    for (let day = 0; day < 31; day += 1) {
      const continuedUseResponse = await exchange({
        grant_type: "refresh_token",
        client_id: registration.client_id,
        refresh_token: current.refresh_token
      });
      assert.equal(continuedUseResponse.status, 200);
      current = await readJson(continuedUseResponse);
    }

    const claims = await verifyMcpAccessToken(env, current.access_token);
    assert.equal(claims.agent_type, "workbuddy");
    const connection = await env.AUTH_DB
      .prepare("SELECT agent_type FROM auth_mcp_connections WHERE id = ?")
      .bind(claims.connection_id)
      .first();
    assert.equal(connection.agent_type, "workbuddy");
    await env.AUTH_DB.prepare(
      "UPDATE auth_mcp_connections SET idle_expires_at = datetime('now', '-1 second') WHERE id = ?"
    ).bind(claims.connection_id).run();
    const idle = await introspectMcpToken(env, current.access_token);
    assert.equal(idle.payload.active, false);
    assert.equal(idle.payload.error, "mcp_connection_idle_expired");
    assert.equal(idle.payload.reason, "idle_expired");

    const idleRefreshResponse = await exchange({
      grant_type: "refresh_token",
      client_id: registration.client_id,
      refresh_token: current.refresh_token
    });
    assert.equal(idleRefreshResponse.status, 400);
    assert.equal((await readJson(idleRefreshResponse)).error, "invalid_grant");
  });

  it("lists and disables all-user MCP connections through service-authenticated admin endpoints", async () => {
    const env = createEnv();
    await insertAuthUser(env, {
      id: "user-admin-mcp",
      email: "admin.mcp@example.invalid",
      name: "Admin MCP User"
    });
    await env.AUTH_DB
      .prepare(
        "INSERT INTO auth_mcp_clients (id, name, status, resource_url, allowed_scopes_json, supported_agents_json) VALUES ('workspace-ai-mcp', 'Workspace MCP', 'active', 'https://mcp.example.test', '[]', '[\"codex\"]')"
      )
      .run();
    await env.AUTH_DB
      .prepare(
        `
        INSERT INTO auth_mcp_connections (
          id, client_id, user_id, agent_type, display_name, resource_url,
          scopes_json, status, last_seen_at
        ) VALUES ('conn-admin-mcp', 'workspace-ai-mcp', 'user-admin-mcp', 'codex', 'Codex Desktop', 'https://mcp.example.test', '[]', 'active', '2026-07-21 08:00:00')
        `
      )
      .run();

    const listResponse = await worker.fetch(new Request(
      "https://auth.test/v1/admin/mcp/connections?status=all&q=Admin%20MCP",
      { headers: { authorization: "Bearer service-token" } }
    ), env);
    const listed = await readJson(listResponse);

    assert.equal(listResponse.status, 200);
    assert.equal(listed.connections.length, 1);
    assert.equal(listed.connections[0].displayName, "Codex Desktop");
    assert.equal(listed.connections[0].user.email, "admin.mcp@example.invalid");
    assert.equal(listed.connections[0].status, "active");

    const disableResponse = await worker.fetch(new Request(
      "https://auth.test/v1/admin/mcp/connections/conn-admin-mcp/disable",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({ actorUserId: "admin-1" })
      }
    ), env);
    const disabled = await readJson(disableResponse);

    assert.equal(disableResponse.status, 200);
    assert.equal(disabled.connection.status, "inactive");
    const stored = await env.AUTH_DB.prepare("SELECT status FROM auth_mcp_connections WHERE id = 'conn-admin-mcp'").first();
    assert.equal(stored.status, "revoked");
    const audit = await env.AUTH_DB
      .prepare("SELECT action, actor_user_id AS actorUserId FROM auth_audit_events WHERE resource_id = 'conn-admin-mcp' ORDER BY created_at DESC LIMIT 1")
      .first();
    assert.equal(audit.action, "mcp_connection_disabled_by_admin");
    assert.equal(audit.actorUserId, "admin-1");
  });

  it("mints and introspects a short-lived resource token", async () => {
    const env = createEnv();
    await registerResource(env);
    await insertAuthUser(env);

    const mintResponse = await worker.fetch(new Request("https://auth.test/v1/resource-tokens/mint", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        resourceId: "resource-funds",
        audience: "https://api.funds.example.com",
        scopes: ["funds:read"],
        toolName: "fund_lookup",
        connectionId: "mcp-conn-1",
        principal: {
          sub: "user-1",
          email: "test.user@example.invalid",
          name: "Ada Zhang",
          role: "member",
          departmentId: "dept-research",
          departmentPath: ["company", "dept-investment", "dept-research"],
          teamId: "team-market-data",
          teamPath: ["company", "dept-investment", "team-market-data"]
        }
      })
    }), env);

    assert.equal(mintResponse.status, 200);
    const mintPayload = await readJson(mintResponse);
    assert.equal(mintPayload.token_type, "Bearer");
    assert.equal(mintPayload.expires_in, 120);
    assert.equal(mintPayload.resource_id, "resource-funds");
    assert.match(mintPayload.access_token, /^[^.]+\.[^.]+\.[^.]+$/);

    const introspectionResponse = await worker.fetch(new Request("https://auth.test/v1/tokens/introspect", {
      method: "POST",
      headers: {
        authorization: "Bearer introspect-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        token: mintPayload.access_token,
        audience: "https://api.funds.example.com",
        scopes: ["funds:read"]
      })
    }), env);
    const introspection = await readJson(introspectionResponse);

    assert.equal(introspectionResponse.status, 200);
    assert.equal(introspection.active, true);
    assert.equal(introspection.resourceId, "resource-funds");
    assert.equal(introspection.principal.sub, "user-1");
    assert.equal(introspection.principal.clientId, "workspace-ai-mcp");
    assert.equal(introspection.principal.connectionId, "mcp-conn-1");
    assert.equal(introspection.principal.orgId, "org-workspace");
    assert.equal(introspection.principal.departmentId, "dept-research");
    assert.deepEqual(introspection.principal.departmentPath, ["company", "dept-investment", "dept-research"]);
    assert.equal(introspection.principal.teamId, undefined);
    assert.deepEqual(introspection.principal.teamPath, []);
    assert.deepEqual(introspection.scopes, ["funds:read"]);
  });

  it("signs live App owner and collaborator roles into App MCP resource tokens", async () => {
    const env = createEnv();
    await registerResource(env, {
      id: "app-mcp:app-academy",
      name: "Academy App MCP",
      audience: "https://academy.example.com",
      accessMode: "public",
      accessTargets: [],
      allowedScopes: ["academy:write"],
      businessOwnerUserId: "owner-1",
      collaboratorUserIds: ["collaborator-1", "owner-1"],
      publisherUserId: "owner-1",
      systemRolePolicyVersion: "2026-08-17T09:30:00.000Z"
    });
    await insertAuthUser(env, {
      id: "collaborator-1",
      email: "collaborator@example.invalid"
    });

    const mintResponse = await worker.fetch(new Request("https://auth.test/v1/resource-tokens/mint", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        resourceId: "app-mcp:app-academy",
        audience: "https://academy.example.com",
        scopes: ["academy:write"],
        principal: { sub: "collaborator-1" }
      })
    }), env);
    assert.equal(mintResponse.status, 200);

    const minted = await readJson(mintResponse);
    const introspectionResponse = await worker.fetch(new Request("https://auth.test/v1/tokens/introspect", {
      method: "POST",
      headers: {
        authorization: "Bearer introspect-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        token: minted.access_token,
        audience: "https://academy.example.com",
        scopes: ["academy:write"]
      })
    }), env);
    const introspection = await readJson(introspectionResponse);

    assert.equal(introspectionResponse.status, 200);
    assert.deepEqual(introspection.principal.appSystemRoles, ["app_collaborator"]);
    assert.equal(introspection.principal.appRolePolicyVersion, "2026-08-17T09:30:00.000Z");

    await env.AUTH_DB
      .prepare("UPDATE auth_users SET id = 'owner-1', email = 'owner@example.invalid' WHERE id = 'collaborator-1'")
      .run();
    const ownerMintResponse = await worker.fetch(new Request("https://auth.test/v1/resource-tokens/mint", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        resourceId: "app-mcp:app-academy",
        audience: "https://academy.example.com",
        scopes: ["academy:write"],
        principal: { sub: "owner-1" }
      })
    }), env);
    const ownerMinted = await readJson(ownerMintResponse);
    const ownerIntrospectionResponse = await worker.fetch(new Request("https://auth.test/v1/tokens/introspect", {
      method: "POST",
      headers: {
        authorization: "Bearer introspect-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ token: ownerMinted.access_token })
    }), env);
    const ownerIntrospection = await readJson(ownerIntrospectionResponse);
    assert.deepEqual(ownerIntrospection.principal.appSystemRoles, ["app_owner"]);
  });

  it("lets a connected App introspect only its own App MCP resource token with App Basic auth", async () => {
    const env = createEnv();
    await registerApp(env);
    await registerResource(env, {
      id: "app-mcp:app-academy",
      name: "Academy App MCP",
      audience: "https://academy.example.com",
      accessMode: "public",
      accessTargets: [],
      allowedScopes: ["academy:write"]
    });
    await insertAuthUser(env);

    const mintResponse = await worker.fetch(new Request("https://auth.test/v1/resource-tokens/mint", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        resourceId: "app-mcp:app-academy",
        audience: "https://academy.example.com",
        scopes: ["academy:write"],
        toolName: "academy_list_admin_videos",
        principal: { sub: "user-1" }
      })
    }), env);
    assert.equal(mintResponse.status, 200);
    const minted = await readJson(mintResponse);
    const appAuthorization = `Basic ${Buffer.from("app-academy:academy-test-client-secret-at-least-32").toString("base64")}`;

    const ownResponse = await worker.fetch(new Request("https://auth.test/v1/tokens/introspect", {
      method: "POST",
      headers: { authorization: appAuthorization, "content-type": "application/json" },
      body: JSON.stringify({
        token: minted.access_token,
        audience: "https://academy.example.com",
        scopes: ["academy:write"]
      })
    }), env);
    const own = await readJson(ownResponse);
    assert.equal(ownResponse.status, 200);
    assert.equal(own.active, true);
    assert.equal(own.resourceId, "app-mcp:app-academy");

    await registerApp(env, {
      id: "app-other",
      appSecret: "other-test-client-secret-at-least-32"
    });
    const otherAuthorization = `Basic ${Buffer.from("app-other:other-test-client-secret-at-least-32").toString("base64")}`;
    const crossAppResponse = await worker.fetch(new Request("https://auth.test/v1/tokens/introspect", {
      method: "POST",
      headers: { authorization: otherAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ token: minted.access_token })
    }), env);
    const crossApp = await readJson(crossAppResponse);
    assert.equal(crossAppResponse.status, 200);
    assert.equal(crossApp.active, false);
  });

  it("uses the current Auth directory snapshot instead of stale broker identity claims", async () => {
    const env = createEnv();
    await registerResource(env, {
      accessTargets: ["department:dept-current"]
    });
    await env.AUTH_DB
      .prepare(
        `
        INSERT INTO auth_users (
          id, email, name, role, status,
          department_id, department_name, department_path_json,
          team_id, team_name, team_path_json
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        "user-current",
        "current@example.invalid",
        "Current User",
        "member",
        "dept-current",
        "Current Department",
        JSON.stringify(["company", "dept-current"]),
        "team-current",
        "Current Team",
        JSON.stringify(["company", "dept-current", "team-current"])
      )
      .run();

    const mintResponse = await worker.fetch(new Request("https://auth.test/v1/resource-tokens/mint", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        resourceId: "resource-funds",
        scopes: ["funds:read"],
        principal: {
          sub: "user-current",
          role: "admin",
          status: "active",
          departmentId: "dept-stale",
          departmentPath: ["company", "dept-stale"],
          teamId: "team-stale",
          teamPath: ["company", "dept-stale", "team-stale"]
        }
      })
    }), env);

    assert.equal(mintResponse.status, 200);
    const minted = await readJson(mintResponse);
    const introspectionResponse = await worker.fetch(new Request("https://auth.test/v1/tokens/introspect", {
      method: "POST",
      headers: {
        authorization: "Bearer introspect-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ token: minted.access_token, scopes: ["funds:read"] })
    }), env);
    const introspection = await readJson(introspectionResponse);

    assert.equal(introspection.principal.role, "member");
    assert.equal(introspection.principal.departmentId, "dept-current");
    assert.deepEqual(introspection.principal.departmentPath, ["company", "dept-current"]);
    assert.equal(introspection.principal.teamId, undefined);
    assert.deepEqual(introspection.principal.teamPath, []);

    const stored = await env.AUTH_DB.prepare(
      "SELECT role, status, department_id, team_id FROM auth_users WHERE id = ?"
    ).bind("user-current").first();
    assert.equal(stored.role, "member");
    assert.equal(stored.status, "active");
    assert.equal(stored.department_id, "dept-current");
    assert.equal(stored.team_id, null);
  });

  it("does not let broker claims reactivate a suspended Auth user", async () => {
    const env = createEnv();
    await registerResource(env, { accessMode: "public" });
    await env.AUTH_DB
      .prepare("INSERT INTO auth_users (id, email, name, role, status) VALUES (?, ?, ?, ?, 'suspended')")
      .bind("user-suspended", "suspended@example.invalid", "Suspended User", "member")
      .run();

    const response = await worker.fetch(new Request("https://auth.test/v1/resource-tokens/mint", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        resourceId: "resource-funds",
        scopes: ["funds:read"],
        principal: {
          sub: "user-suspended",
          role: "admin",
          status: "active"
        }
      })
    }), env);
    const payload = await readJson(response);

    assert.equal(response.status, 403);
    assert.equal(payload.error, "denied_user_inactive");
    const stored = await env.AUTH_DB.prepare("SELECT status, role FROM auth_users WHERE id = ?").bind("user-suspended").first();
    assert.equal(stored.status, "suspended");
    assert.equal(stored.role, "member");
  });

  it("introspects current Auth identity without stale JWT claims and records bound connection activity", async () => {
    const env = createEnv();
    await insertMcpConnection(env);
    await env.AUTH_DB.prepare("UPDATE auth_users SET email='current@example.com',department_id='dept-current',department_name='Current',department_path_json='[\"company\",\"dept-current\"]' WHERE id='user-mcp'").run();
    const token = await createMcpToken(env);
    const { payload, response } = await introspectMcpToken(env, token);

    assert.equal(response.status, 200);
    assert.equal(payload.active, true);
    assert.equal(payload.authenticatedAt, "2020-01-01 00:00:00");
    assert.equal(payload.clientId, "workspace-ai-mcp");
    assert.equal(payload.principal.sub, "user-mcp");
    assert.equal(payload.principal.connectionId, "conn-current");
    assert.equal(payload.principal.departmentId, "dept-current");
    assert.deepEqual(payload.principal.departmentPath, ["company", "dept-current"]);
    assert.equal(payload.principal.teamId, undefined);
    assert.equal(payload.principal.email, "current@example.com");
    assert.equal(payload.principal.role, "member");
    assert.deepEqual(payload.principal.scopes, ["workspace:knowledge:read"]);

    const stored = await env.AUTH_DB
      .prepare("SELECT status, last_seen_at AS lastSeenAt FROM auth_mcp_connections WHERE id = ?")
      .bind("conn-current")
      .first();
    assert.equal(stored.status, "active");
    assert.notEqual(stored.lastSeenAt, "2020-01-01 00:00:00");
  });

  it("rejects an existing MCP connection when its user is disabled or missing without recording activity", async () => {
    for (const status of ["inactive", "missing"]) {
      const env = createEnv();
      await insertMcpConnection(env);
      await env.AUTH_DB.prepare(status === "missing" ? "DELETE FROM auth_users WHERE id='user-mcp'" : "UPDATE auth_users SET status='inactive' WHERE id='user-mcp'").run();
      const { payload, response } = await introspectMcpToken(env, await createMcpToken(env));
      assert.equal(response.status, 200);
      assert.equal(payload.active, false);
      assert.equal(payload.reason, "user_inactive");
      const stored = await env.AUTH_DB.prepare("SELECT last_seen_at FROM auth_mcp_connections WHERE id='conn-current'").first();
      assert.equal(stored.last_seen_at, "2020-01-01 00:00:00");
    }
  });

  it("returns a stable reauthorization contract for revoked and missing MCP connections without recording activity", async () => {
    const env = createEnv();
    await insertMcpConnection(env, { status: "revoked" });
    const revokedToken = await createMcpToken(env);
    const revoked = await introspectMcpToken(env, revokedToken);

    assert.equal(revoked.response.status, 200);
    assert.deepEqual(
      {
        active: revoked.payload.active,
        authorizationUrl: revoked.payload.authorization_url,
        connectionId: revoked.payload.connectionId,
        error: revoked.payload.error,
        reason: revoked.payload.reason,
        reauthorize: revoked.payload.reauthorize
      },
      {
        active: false,
        authorizationUrl: "https://auth.workspace.internal/auth/mcp/oauth/authorize",
        connectionId: "conn-current",
        error: "mcp_connection_revoked",
        reason: "revoked",
        reauthorize: true
      }
    );

    const stored = await env.AUTH_DB
      .prepare("SELECT last_seen_at AS lastSeenAt FROM auth_mcp_connections WHERE id = ?")
      .bind("conn-current")
      .first();
    assert.equal(stored.lastSeenAt, "2020-01-01 00:00:00");

    const missingToken = await createMcpToken(env, { connection_id: "conn-missing" });
    const missing = await introspectMcpToken(env, missingToken);
    assert.equal(missing.response.status, 200);
    assert.equal(missing.payload.active, false);
    assert.equal(missing.payload.connectionId, "conn-missing");
    assert.equal(missing.payload.error, "mcp_connection_reauthorization_required");
    assert.equal(missing.payload.reason, "connection_not_found");
    assert.equal(missing.payload.reauthorize, true);
  });

  it("rejects MCP tokens whose subject or client does not match the active connection without touching it", async () => {
    const env = createEnv();
    await insertMcpConnection(env);

    const subjectMismatch = await introspectMcpToken(
      env,
      await createMcpToken(env, { sub: "different-user" })
    );
    assert.equal(subjectMismatch.response.status, 200);
    assert.equal(subjectMismatch.payload.active, false);
    assert.equal(subjectMismatch.payload.error, "mcp_connection_binding_mismatch");
    assert.equal(subjectMismatch.payload.reason, "subject_mismatch");
    assert.equal(subjectMismatch.payload.reauthorize, true);

    const clientMismatch = await introspectMcpToken(
      env,
      await createMcpToken(env, { client_id: "different-client" })
    );
    assert.equal(clientMismatch.response.status, 200);
    assert.equal(clientMismatch.payload.active, false);
    assert.equal(clientMismatch.payload.error, "mcp_connection_binding_mismatch");
    assert.equal(clientMismatch.payload.reason, "client_mismatch");
    assert.equal(clientMismatch.payload.reauthorize, true);

    const stored = await env.AUTH_DB
      .prepare("SELECT status, last_seen_at AS lastSeenAt FROM auth_mcp_connections WHERE id = ?")
      .bind("conn-current")
      .first();
    assert.equal(stored.status, "active");
    assert.equal(stored.lastSeenAt, "2020-01-01 00:00:00");
  });

  it("lets the authenticated MCP broker mint without reading a connection row", async () => {
    const env = {
      ...createEnv(),
      MCP_INTROSPECTION_TOKEN: "mcp-introspection-token"
    };
    await registerResource(env, { accessMode: "public" });
    await insertAuthUser(env);
    const response = await worker.fetch(new Request("https://auth.test/v1/resource-tokens/mint", {
      method: "POST",
      headers: {
        authorization: "Bearer mcp-introspection-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        resourceId: "resource-funds",
        audience: "https://api.funds.example.com",
        scopes: ["funds:read"],
        clientId: "workspace-ai-mcp",
        connectionId: "mcp-conn-1",
        principal: {
          sub: "user-1",
          email: "test.user@example.invalid",
          name: "Ada Zhang",
          role: "member"
        }
      })
    }), env);

    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.equal(payload.resource_id, "resource-funds");
    assert.match(payload.access_token, /^[^.]+\.[^.]+\.[^.]+$/);
  });

  it("does not recheck a revoked MCP connection when the service-token fallback is brokered", async () => {
    const env = createEnv();
    await registerResource(env, { accessMode: "public" });
    await insertAuthUser(env, {
      id: "user-fallback",
      email: "fallback@example.invalid",
      name: "Fallback User"
    });
    await env.AUTH_DB
      .prepare("INSERT INTO auth_mcp_clients (id, name, status, resource_url, allowed_scopes_json) VALUES ('workspace-ai-mcp', 'Workspace MCP', 'disabled', ?, ?)")
      .bind("https://mcp.example.invalid", JSON.stringify([]))
      .run();
    await env.AUTH_DB
      .prepare("INSERT INTO auth_mcp_connections (id, client_id, user_id, agent_type, display_name, resource_url, scopes_json, status) VALUES ('mcp-fallback', 'workspace-ai-mcp', 'user-fallback', 'codex', 'Codex', ?, ?, 'revoked')")
      .bind("https://mcp.example.invalid", JSON.stringify(["funds:read"]))
      .run();

    const request = () => worker.fetch(new Request("https://auth.test/v1/resource-tokens/mint", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        resourceId: "resource-funds",
        scopes: ["funds:read"],
        clientId: "workspace-ai-mcp",
        connectionId: "mcp-fallback",
        mcpBrokered: true,
        principal: { sub: "user-fallback", role: "member" }
      })
    }), env);

    const response = await request();
    const payload = await readJson(response);
    assert.equal(response.status, 200);
    assert.equal(payload.resource_id, "resource-funds");
  });

  it("accepts the dedicated Mate Runtime credential for per-user resource minting", async () => {
    const env = {
      ...createEnv(),
      MATE_RUNTIME_AUTH_SERVICE_TOKEN: "mate-runtime-service-token"
    };
    await registerResource(env, { accessMode: "public" });
    await insertAuthUser(env);

    const mateMintResponse = await worker.fetch(new Request("https://auth.test/v1/resource-tokens/mint", {
      method: "POST",
      headers: {
        authorization: "Bearer mate-runtime-service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        audience: "https://api.funds.example.com",
        clientId: "workspace-mate-runtime",
        mcpBrokered: false,
        principal: { sub: "user-1" },
        resourceId: "resource-funds",
        scopes: ["funds:read"],
        toolName: "mate_knowledge_read"
      })
    }), env);
    assert.equal(mateMintResponse.status, 200, await mateMintResponse.clone().text());

    const generalMcpStatusResponse = await worker.fetch(new Request("https://auth.test/v1/mcp/connections/status", {
      method: "POST",
      headers: {
        authorization: "Bearer mate-runtime-service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ userId: "user-1" })
    }), env);
    assert.equal(generalMcpStatusResponse.status, 401);

    const adminResponse = await worker.fetch(new Request("https://auth.test/v1/admin/apps", {
      method: "POST",
      headers: {
        authorization: "Bearer mate-runtime-service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    }), env);
    assert.equal(adminResponse.status, 401);
  });

  it("resolves Cortana email and scheduled principals only through exact active Auth records", async () => {
    const env = {
      ...createEnv(),
      MATE_RUNTIME_AUTH_SERVICE_TOKEN: "mate-runtime-service-token"
    };
    await insertAuthUser(env, { email: "ai-adoption@example.invalid" });
    await insertAuthUser(env, { id: "user-suspended", email: "suspended@example.invalid", status: "suspended" });

    const emailPrincipal = await worker.fetch(new Request("https://auth.test/v1/internal/mate/email-principal", {
      body: JSON.stringify({ email: "AI-ADOPTION@example.invalid" }),
      headers: { authorization: "Bearer mate-runtime-service-token", "content-type": "application/json" },
      method: "POST"
    }), env);
    assert.equal(emailPrincipal.status, 200, await emailPrincipal.clone().text());
    assert.equal((await readJson(emailPrincipal)).user.id, "user-1");

    const partialEmail = await worker.fetch(new Request("https://auth.test/v1/internal/mate/email-principal", {
      body: JSON.stringify({ email: "ai-adoption" }),
      headers: { authorization: "Bearer mate-runtime-service-token", "content-type": "application/json" },
      method: "POST"
    }), env);
    assert.equal(partialEmail.status, 403);

    const suspended = await worker.fetch(new Request("https://auth.test/v1/internal/mate/user-principal", {
      body: JSON.stringify({ userId: "user-suspended" }),
      headers: { authorization: "Bearer mate-runtime-service-token", "content-type": "application/json" },
      method: "POST"
    }), env);
    assert.equal(suspended.status, 403);

    const wrongToken = await worker.fetch(new Request("https://auth.test/v1/internal/mate/user-principal", {
      body: JSON.stringify({ userId: "user-1" }),
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      method: "POST"
    }), env);
    assert.equal(wrongToken.status, 401);
  });

  it("denies minting when the user does not match the resource access policy", async () => {
    const env = createEnv();
    await registerResource(env);
    await insertAuthUser(env, {
      id: "user-2",
      email: "grace@example.com",
      name: "Grace",
      departmentId: "dept-hr",
      departmentPath: ["company", "dept-hr"],
      teamId: undefined,
      teamPath: []
    });

    const response = await worker.fetch(new Request("https://auth.test/v1/resource-tokens/mint", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        resourceId: "resource-funds",
        scopes: ["funds:read"],
        principal: {
          sub: "user-2",
          email: "grace@example.com",
          role: "member",
          departmentId: "dept-hr",
          departmentPath: ["company", "dept-hr"]
        }
      })
    }), env);
    const payload = await readJson(response);

    assert.equal(response.status, 403);
    assert.equal(payload.error, "denied_not_targeted");
  });
});

describe("resource mint service credential boundary", () => {
  for (const configured of ["", "   "]) {
    it(`rejects an unauthenticated mint with a ${configured === "" ? "blank" : "whitespace"} optional runtime credential`, async () => {
      const env = createEnv();
      env.MATE_RUNTIME_AUTH_SERVICE_TOKEN = configured;
      await registerResource(env);
      await insertAuthUser(env);
      const response = await worker.fetch(new Request("https://auth.test/v1/resource-tokens/mint", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceId: "resource-funds", audience: "https://api.funds.example.com",
          scopes: ["funds:read"], toolName: "fund_lookup",
          principal: {
            sub: "user-1", email: "test.user@example.invalid", name: "Ada Zhang", role: "member",
            departmentId: "dept-research", departmentPath: ["company", "dept-investment", "dept-research"],
            teamId: "team-market-data", teamPath: ["company", "dept-investment", "team-market-data"]
          }
        })
      }), env);
      assert.equal(response.status, 401);
      assert.equal((await readJson(response)).error, "invalid_resource_mint_token");
    });
  }
  it("reports missing mint credentials after normalizing blank configuration", async () => {
    const response = await worker.fetch(new Request("https://auth.test/v1/resource-tokens/mint", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    }), {
      AUTH_SERVICE_TOKEN: "", AUTH_SERVICE_TOKEN_SECONDARY: " ", PORTAL_AUTH_SERVICE_TOKEN: "",
      MATE_RUNTIME_AUTH_SERVICE_TOKEN: " ", MCP_INTROSPECTION_TOKEN: " "
    });
    assert.equal(response.status, 503);
    assert.equal((await readJson(response)).error, "resource_mint_token_not_configured");
  });
});


describe("enterprise MCP domain isolation", () => {
  it("authorizes the configured domain and refuses the legacy installation", async () => {
    const env = { ...createEnv(), MCP_RESOURCE_URL: "https://mcp.enterprise.example" };
    const request = resource => new Request("https://auth.test/v1/mcp/oauth/device_authorization", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "workspace-cli-workbuddy", resource })
    });
    assert.equal((await worker.fetch(request("https://mcp.enterprise.example/mcp"), env)).status, 200);
    assert.equal((await worker.fetch(request("https://mcp.example.invalid/mcp"), env)).status, 400);
    assert.equal((await worker.fetch(request("https://mcp.enterprise.example/mcp"), { ...env, MCP_RESOURCE_URL: undefined })).status, 400);
  });
});
