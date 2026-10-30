import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  approveMcpDeviceCode,
  consumeMcpDeviceCode,
  createMcpDeviceCode,
  disableAdminMcpConnection,
  ensureMcpClient,
  listAdminMcpConnections,
  listAuthUsers,
  listAppUsers,
  planAuthLoginUser,
  readAuthDepartmentDisplayPath,
  readMcpConnectionStatus,
  recordAppUserLogin,
  registerAppClient,
  revokeMcpConnection,
  resolveAuthLoginUser,
  resolveAuthDepartmentHierarchy,
  resolveEmailOtpAuthUser,
  resolveAuthUserSnapshot,
  touchMcpConnection,
  upsertAuthDepartment,
  upsertAuthUserSnapshot
} from "./repository.ts";

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

describe("auth repository smoke", () => {
  it("shows explicitly stored department ancestry for every source", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };
    await upsertAuthDepartment(env, { id: "dept-root", name: "Workspace Wealth Group Limited", path: ["dept-root"], source: "moka" });
    await upsertAuthDepartment(env, { id: "dept-group", name: "Group", parentId: "dept-root", path: ["dept-root", "dept-group"], source: "moka" });
    await upsertAuthDepartment(env, { id: "dept-ai", name: "AI Adoption", parentId: "dept-group", path: ["dept-root", "dept-group", "dept-ai"], source: "moka" });

    assert.equal(await readAuthDepartmentDisplayPath(env, {
      departmentPath: ["dept-root", "dept-group", "dept-ai"],
      source: "moka"
    }), "Workspace Wealth Group Limited/Group/AI Adoption");
    assert.equal(await readAuthDepartmentDisplayPath(env, {
      departmentPath: ["dept-root", "dept-group", "dept-missing"],
      source: "moka"
    }), undefined);
    assert.equal(await readAuthDepartmentDisplayPath(env, {
      departmentPath: ["dept-root", "dept-group", "dept-ai"],
      source: "portal"
    }), "Workspace Wealth Group Limited/Group/AI Adoption");
  });

  it("rejects retired Platform Admin role identifiers", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };
    const retiredRole = ["portal", "admin"].join("_");

    await assert.rejects(
      upsertAuthUserSnapshot(env, {
        email: "legacy.admin@example.invalid",
        id: "legacy-admin",
        name: "Legacy Admin",
        role: retiredRole,
        status: "active"
      }),
      { status: 400, message: "invalid_user_role" }
    );
  });

  it("stores org snapshots and app login history against the real schema", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };

    await upsertAuthDepartment(env, {
      id: "dept-investment",
      name: "Investment",
      path: ["company", "dept-investment"]
    });

    const user = await upsertAuthUserSnapshot(env, {
      department: "Research",
      departmentId: "dept-research",
      departmentPath: ["company", "dept-investment", "dept-research"],
      email: "test.user@example.invalid",
      id: "user-1",
      jobTitle: "Research Analyst",
      name: "Ada Zhang",
      role: "member",
      status: "active",
      team: "Market Data",
      teamId: "team-market-data",
      teamPath: ["company", "dept-investment", "team-market-data"]
    });

    const app = await registerAppClient(env, {
      appSecret: "repository-test-app-client-secret-at-least-32",
      accessMode: "targeted",
      accessTargets: ["department:dept-investment"],
      callbackUrls: ["https://market.example.com/auth/workspace/callback"],
      id: "app-market",
      name: "Market Data",
      sdkStatus: "connected",
      status: "listed"
    });

    await recordAppUserLogin(env, {
      access: {
        action: "token",
        appId: "app-market",
        decision: "allow",
        policyVersion: "test",
        reason: "allowed_target_match"
      },
      app,
      requestId: "req-1",
      user
    });

    const users = await listAppUsers(env, "app-market");

    assert.equal(users.length, 1);
    assert.equal(users[0].userId, "user-1");
    assert.equal(users[0].email, "test.user@example.invalid");
    assert.equal(users[0].departmentId, "dept-research");
    // Personnel teams are intentionally disabled; the schema clears any
    // incoming team assignment while retaining the full department path.
    assert.equal(users[0].teamId, null);
    assert.equal(users[0].jobTitle, "Research Analyst");
    assert.equal(users[0].loginCount, 1);
    assert.equal(users[0].lastDecision, "allow");

    const updatedUser = await upsertAuthUserSnapshot(env, {
      ...user,
      department: "Finance",
      departmentId: "dept-finance",
      jobTitle: "AVP-Finance",
      name: "Ada Zhang Updated",
      source: "moka"
    });
    await recordAppUserLogin(env, {
      access: { action: "token", appId: app.id, decision: "allow", policyVersion: "test", reason: "allowed_target_match" },
      app,
      // An application can still carry the snapshot from before the Moka update.
      user
    });
    const [updatedAppUser] = await listAppUsers(env, app.id);
    assert.equal(updatedAppUser.jobTitle, "AVP-Finance");
    assert.equal(updatedAppUser.name, "Ada Zhang Updated");
    assert.equal(updatedAppUser.departmentId, "dept-finance");
    assert.equal(updatedAppUser.loginCount, 2);
    const [canonicalUser] = await listAuthUsers(env, { search: updatedUser.email });
    assert.equal(canonicalUser.jobTitle, "AVP-Finance");
    assert.equal(canonicalUser.name, "Ada Zhang Updated");
    assert.equal(canonicalUser.departmentId, "dept-finance");
  });

  it("stores invited users for pre-authorization", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };

    const user = await upsertAuthUserSnapshot(env, {
      department: "Investment / Research",
      departmentId: "dept-research",
      departmentPath: ["dept-investment", "dept-research"],
      email: "invited.user@example.invalid",
      id: "invited.user@example.invalid",
      name: "Invited User",
      role: "member",
      source: "admin_import",
      status: "invited"
    });
    const users = await listAuthUsers(env, { statuses: ["invited"] });

    assert.equal(user.status, "invited");
    assert.equal(users.length, 1);
    assert.equal(users[0].id, "invited.user@example.invalid");
    assert.equal(users[0].status, "invited");
    assert.equal(users[0].departmentId, "dept-research");
  });

  it("preserves an admin-imported department when a portal snapshot disagrees", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };
    await upsertAuthUserSnapshot(env, {
      department: "Workspace Wealth / MT",
      departmentId: "dept-mt",
      departmentPath: ["dept-workspace-wealth", "dept-mt"],
      email: "alyssa.lin@example.invalid",
      id: "user-alyssa",
      name: "Alyssa Lin",
      role: "member",
      source: "admin_import",
      status: "active"
    });

    const resolved = await resolveAuthUserSnapshot(env, {
      department: "EV / Business Development",
      departmentId: "dept-business-development",
      departmentPath: ["dept-ev", "dept-business-development"],
      email: "alyssa.lin@example.invalid",
      id: "user-alyssa",
      name: "Alyssa Lin",
      role: "member",
      source: "portal",
      status: "active"
    });

    assert.equal(resolved.department, "Workspace Wealth / MT");
    assert.equal(resolved.departmentId, "dept-mt");
    assert.deepEqual(resolved.departmentPath, ["dept-workspace-wealth", "dept-mt"]);
    const memberships = await env.AUTH_DB
      .prepare("SELECT target_id AS targetId FROM auth_user_memberships WHERE user_id=? AND target_type='department' AND status='active' ORDER BY target_id")
      .bind("user-alyssa")
      .all();
    assert.deepEqual(memberships.results.map((row) => row.targetId), ["dept-mt"]);
  });

  it("resolves email OTP users by exact full email without prefix fallback", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };

    await upsertAuthUserSnapshot(env, {
      email: "ops.user@example.invalid",
      id: "ops-hk",
      name: "HK Ops",
      provider: "microsoft_entra_id",
      providerSubject: "entra-ops-hk",
      role: "admin",
      status: "active"
    });
    await upsertAuthUserSnapshot(env, {
      email: "ops.user@partner.example.test",
      id: "ops-gh",
      name: "GH Ops",
      provider: "microsoft_entra_id",
      providerSubject: "entra-ops-gh",
      role: "member",
      status: "active"
    });

    const exact = await resolveEmailOtpAuthUser(env, "OPS.USER@PARTNER.EXAMPLE.TEST");
    assert.equal(exact.id, "ops-gh");
    assert.equal(exact.providerSubject, "entra-ops-gh");

    await assert.rejects(
      () => resolveEmailOtpAuthUser(env, "ops.user@other.example.test"),
      (error) => error.status === 403 && error.code === "email_otp_not_allowed"
    );
  });

  it("activates invited email OTP users without replacing their identity provider", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };

    await upsertAuthUserSnapshot(env, {
      department: "Workspace Wealth / AI Adoption",
      email: "ai-adoption@example.invalid",
      id: "ai-adoption",
      name: "AI Adoption Platform",
      provider: "microsoft_entra_id",
      providerSubject: "entra-ai-adoption",
      role: "member",
      status: "invited"
    });

    const user = await resolveEmailOtpAuthUser(env, "ai-adoption@example.invalid");
    const row = await env.AUTH_DB
      .prepare("SELECT status, provider, provider_subject AS providerSubject FROM auth_users WHERE id = ?")
      .bind("ai-adoption")
      .first();

    assert.equal(user.status, "active");
    assert.equal(row.status, "active");
    assert.equal(row.provider, "microsoft_entra_id");
    assert.equal(row.providerSubject, "entra-ai-adoption");
  });

  it("rejects inactive and suspended users from email OTP", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };

    for (const status of ["inactive", "suspended"]) {
      await upsertAuthUserSnapshot(env, {
        email: `${status}@example.invalid`,
        id: status,
        name: status,
        role: "member",
        status
      });
      await assert.rejects(
        () => resolveEmailOtpAuthUser(env, `${status}@example.invalid`),
        (error) => error.status === 403 && error.code === "email_otp_not_allowed"
      );
    }
  });

  it("migrates legacy MCP rows safely and enforces the sliding idle deadline", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE auth_mcp_clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        resource_url TEXT NOT NULL DEFAULT '',
        allowed_scopes_json TEXT NOT NULL DEFAULT '[]',
        supported_agents_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE auth_mcp_connections (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        resource_url TEXT NOT NULL DEFAULT '',
        scopes_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TEXT
      );
      INSERT INTO auth_mcp_clients (id) VALUES ('workspace-ai-mcp');
      INSERT INTO auth_mcp_connections (
        id, client_id, user_id, agent_type, last_seen_at, created_at, updated_at
      ) VALUES
        ('conn-recent', 'workspace-ai-mcp', 'user-recent', 'codex', datetime('now'), datetime('now'), datetime('now')),
        ('conn-idle', 'workspace-ai-mcp', 'user-idle', 'codex', datetime('now', '-8 days'), datetime('now', '-8 days'), datetime('now', '-8 days'));
    `);
    database.exec(readFileSync("workers/auth/db/d1-migrations/0002_mcp_idle_expiration.sql", "utf8"));
    database.exec(readFileSync("workers/auth/db/d1-migrations/0003_mcp_oauth_credentials.sql", "utf8"));
    const env = { AUTH_DB: new D1Adapter(database), MCP_IDLE_TTL_SECONDS: "604800" };

    const before = database.prepare(
      "SELECT status, idle_expires_at AS idleExpiresAt FROM auth_mcp_connections WHERE id = 'conn-recent'"
    ).get();
    assert.equal(before.status, "active");
    assert.ok(Date.parse(`${before.idleExpiresAt}Z`) > Date.now() + 6 * 24 * 60 * 60 * 1000);

    database.prepare("UPDATE auth_mcp_connections SET idle_expires_at = datetime('now', '+1 hour') WHERE id = 'conn-recent'").run();
    assert.equal(await touchMcpConnection(env, "conn-recent"), true);
    const touched = database.prepare(
      "SELECT idle_expires_at AS idleExpiresAt FROM auth_mcp_connections WHERE id = 'conn-recent'"
    ).get();
    assert.ok(Date.parse(`${touched.idleExpiresAt}Z`) > Date.now() + 6 * 24 * 60 * 60 * 1000);

    const idleStatus = await readMcpConnectionStatus(env, "user-idle");
    assert.equal(idleStatus.connected, false);
    assert.equal(idleStatus.credentialState, "idle_expired");
    const idle = database.prepare(
      "SELECT status, revoked_reason AS revokedReason FROM auth_mcp_connections WHERE id = 'conn-idle'"
    ).get();
    assert.equal(idle.status, "revoked");
    assert.equal(idle.revokedReason, "idle_expired");
  });

  it("migrates every active Device Bearer connection to OAuth reauthorization", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE auth_mcp_clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        resource_url TEXT NOT NULL DEFAULT '',
        allowed_scopes_json TEXT NOT NULL DEFAULT '[]',
        supported_agents_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE auth_mcp_connections (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        resource_url TEXT NOT NULL DEFAULT '',
        scopes_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TEXT
      );
      INSERT INTO auth_mcp_clients (id) VALUES ('workspace-ai-mcp');
      INSERT INTO auth_mcp_connections (id, client_id, user_id, agent_type) VALUES
        ('conn-device', 'workspace-ai-mcp', 'user-device', 'workbuddy'),
        ('conn-oauth-code', 'workspace-ai-mcp', 'user-oauth-code', 'codex'),
        ('conn-oauth-refresh', 'workspace-ai-mcp', 'user-oauth-refresh', 'cursor');
    `);
    database.exec(readFileSync("workers/auth/db/d1-migrations/0002_mcp_idle_expiration.sql", "utf8"));
    database.exec(readFileSync("workers/auth/db/d1-migrations/0003_mcp_oauth_credentials.sql", "utf8"));
    database.exec(`
      INSERT INTO auth_mcp_oauth_clients (client_id, client_name) VALUES
        ('oauth-code', 'Codex'),
        ('oauth-refresh', 'Cursor');
      INSERT INTO auth_mcp_authorization_codes (
        code_hash, oauth_client_id, connection_id, user_id, redirect_uri,
        code_challenge, resource_url, expires_at
      ) VALUES (
        'code-hash', 'oauth-code', 'conn-oauth-code', 'user-oauth-code',
        'http://127.0.0.1/callback', 'challenge', 'https://mcp.example.invalid/mcp',
        datetime('now', '+5 minutes')
      );
      INSERT INTO auth_mcp_refresh_tokens (
        token_hash, oauth_client_id, connection_id, user_id, resource_url, expires_at
      ) VALUES (
        'refresh-hash', 'oauth-refresh', 'conn-oauth-refresh', 'user-oauth-refresh',
        'https://mcp.example.invalid/mcp', datetime('now', '+7 days')
      );
    `);

    database.exec(readFileSync("workers/auth/db/d1-migrations/0004_mcp_oauth_only.sql", "utf8"));

    const rows = database.prepare(
      "SELECT id, status, revoked_reason AS revokedReason FROM auth_mcp_connections ORDER BY id"
    ).all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { id: "conn-device", status: "revoked", revokedReason: "oauth_migration_required" },
      { id: "conn-oauth-code", status: "active", revokedReason: null },
      { id: "conn-oauth-refresh", status: "active", revokedReason: null }
    ]);
    const oauthClients = database.prepare(
      "SELECT client_id AS clientId, agent_type AS agentType FROM auth_mcp_oauth_clients ORDER BY client_id"
    ).all().map((row) => ({ ...row }));
    assert.deepEqual(oauthClients, [
      { clientId: "oauth-code", agentType: "codex" },
      { clientId: "oauth-refresh", agentType: "codex" }
    ]);
  });

  it("grants explicit mailbox, APPS and Knowledge scopes by default", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };
    env.MCP_RESOURCE_URL = "https://mcp.example.invalid";
    await ensureMcpClient(env);

    const defaultCode = await createMcpDeviceCode(env, {
      agentType: "codex",
      displayName: "Codex"
    });
    assert.deepEqual(defaultCode.scopes, [
      "workspace:mail:read",
      "workspace:mail:write",
      "workspace:mail:send",
      "workspace:forum:read",
      "workspace:forum:write",
      "workspace:hub:read",
      "workspace:apps:read",
      "workspace:apps:write",
      "workspace:knowledge:read",
      "workspace:knowledge:write",
      "workspace:knowledge:share"
    ]);

    const writeCode = await createMcpDeviceCode(env, {
      agentType: "codex",
      displayName: "Codex Writer",
      scopes: ["workspace:apps:read", "workspace:apps:write"]
    });
    assert.deepEqual(writeCode.scopes, ["workspace:apps:read", "workspace:apps:write"]);

    await assert.rejects(
      () => createMcpDeviceCode(env, {
        agentType: "codex",
        displayName: "Invalid Admin Scope",
        scopes: ["workspace:knowledge:admin"]
      }),
      (error) => error.status === 400 && error.code === "invalid_mcp_scope"
    );
  });

  it("lists all-user MCP connections by activity, user search, and lifecycle status", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };
    env.MCP_RESOURCE_URL = "https://mcp.example.invalid";
    await ensureMcpClient(env);
    await upsertAuthUserSnapshot(env, {
      id: "user-ada",
      email: "ada@example.invalid",
      name: "Ada Zhang",
      department: "Platform",
      team: "AI Adoption"
    });
    await upsertAuthUserSnapshot(env, {
      id: "user-grace",
      email: "grace@example.invalid",
      name: "Grace Hopper",
      department: "Engineering"
    });
    const insertConnection = (id, userId, status, lastSeenAt, agentType, displayName) => env.AUTH_DB
      .prepare(
        `
        INSERT INTO auth_mcp_connections (
          id, client_id, user_id, agent_type, display_name, resource_url,
          scopes_json, status, last_seen_at, created_at, updated_at
        ) VALUES (?, 'workspace-ai-mcp', ?, ?, ?, 'https://mcp.example.test', '["workspace:forum:read"]', ?, ?, '2026-07-01 00:00:00', '2026-07-10 00:00:00')
        `
      )
      .bind(id, userId, agentType, displayName, status, lastSeenAt)
      .run();

    await insertConnection("conn-ada-old", "user-ada", "revoked", "2026-07-15 09:00:00", "claude-code", "Claude Terminal");
    await insertConnection("conn-ada-active", "user-ada", "active", "2026-07-20 09:00:00", "codex", "Codex Desktop");
    await insertConnection("conn-grace-active", "user-grace", "active", "2026-07-21 09:00:00", "cursor", "Cursor Mac");

    const active = await listAdminMcpConnections(env);
    assert.deepEqual(active.connections.map((connection) => connection.id), ["conn-grace-active", "conn-ada-active"]);
    assert.equal(active.connections[0].displayName, "Cursor Mac");
    assert.equal(active.connections[0].agentType, "cursor");
    assert.equal(active.connections[0].user.email, "grace@example.invalid");
    assert.deepEqual(active.summary, { activeCount: 2, inactiveCount: 1, totalCount: 3, userCount: 2 });

    const ada = await listAdminMcpConnections(env, { q: "ada", status: "all" });
    assert.deepEqual(ada.connections.map((connection) => connection.id), ["conn-ada-active", "conn-ada-old"]);
    assert.equal(ada.connections[1].status, "inactive");
    assert.deepEqual(ada.summary, active.summary);

    const empty = await listAdminMcpConnections(env, { q: "no-matching-user", status: "inactive" });
    assert.deepEqual(empty.connections, []);
    assert.deepEqual(empty.summary, active.summary);

    const disabled = await disableAdminMcpConnection(env, "conn-ada-active");
    assert.equal(disabled.status, "revoked");
    const inactive = await listAdminMcpConnections(env, { q: "Ada Zhang", status: "inactive" });
    assert.deepEqual(inactive.connections.map((connection) => connection.id), ["conn-ada-active", "conn-ada-old"]);
    assert.ok(inactive.connections.every((connection) => connection.status === "inactive"));
    assert.deepEqual(inactive.summary, { activeCount: 1, inactiveCount: 2, totalCount: 3, userCount: 2 });
  });

  it("approves below the MCP connection limit without revoking an existing connection", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };
    env.MCP_RESOURCE_URL = "https://mcp.example.invalid";
    await ensureMcpClient(env);
    const code = await createMcpDeviceCode(env, {
      agentType: "codex",
      displayName: "Codex"
    });

    const approval = await approveMcpDeviceCode(env, code.userCode, {
      id: "user-below-limit",
      email: "below-limit@example.invalid",
      name: "Below Limit"
    });
    const connections = await env.AUTH_DB
      .prepare("SELECT id, status FROM auth_mcp_connections WHERE user_id = ? ORDER BY id")
      .bind("user-below-limit")
      .all();

    assert.equal(approval.autoRevokedConnectionId, undefined);
    assert.equal(connections.results.length, 1);
    assert.equal(connections.results[0].id, approval.connectionId);
    assert.equal(connections.results[0].status, "active");
  });

  it("does not consume an approved device code after its connection has been revoked", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };
    env.MCP_RESOURCE_URL = "https://mcp.example.invalid";
    await ensureMcpClient(env);
    const code = await createMcpDeviceCode(env, {
      agentType: "codex",
      displayName: "Codex Pending Token"
    });
    const user = { id: "user-revoked-before-consume", name: "Revoked Before Consume" };
    const approval = await approveMcpDeviceCode(env, code.userCode, user);

    await revokeMcpConnection(env, user.id, approval.connectionId);

    await assert.rejects(
      () => consumeMcpDeviceCode(env, code.deviceCode),
      (error) => error.status === 401 && error.code === "mcp_connection_revoked"
    );
    const storedCode = await env.AUTH_DB
      .prepare("SELECT status, consumed_at AS consumedAt FROM auth_mcp_device_codes WHERE device_code = ?")
      .bind(code.deviceCode)
      .first();
    assert.equal(storedCode.status, "approved");
    assert.equal(storedCode.consumedAt, null);
  });

  it("keeps concurrent MCP approvals capped by atomically replacing the least recently used connections", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };
    env.MCP_RESOURCE_URL = "https://mcp.example.invalid";
    await ensureMcpClient(env);
    const userId = "user-at-limit";
    const insertConnection = (id, lastSeenAt, createdAt, updatedAt) => env.AUTH_DB
      .prepare(
        `
        INSERT INTO auth_mcp_connections (
          id, client_id, user_id, agent_type, display_name, resource_url,
          scopes_json, status, last_seen_at, created_at, updated_at
        ) VALUES (?, 'workspace-ai-mcp', ?, 'codex', ?, 'https://mcp.example.invalid', '[]', 'active', ?, ?, ?)
        `
      )
      .bind(id, userId, id, lastSeenAt, createdAt, updatedAt)
      .run();

    await insertConnection("connection-oldest", "2026-01-01 00:00:00", "2025-12-01 00:00:00", "2026-06-01 00:00:00");
    await insertConnection("connection-middle", null, "2025-12-02 00:00:00", "2026-02-01 00:00:00");
    await insertConnection("connection-newest", "2026-03-01 00:00:00", "2025-12-03 00:00:00", "2026-03-01 00:00:00");
    await env.AUTH_DB.prepare(
      "INSERT INTO auth_mcp_oauth_clients (client_id, client_name) VALUES ('oauth-codex', 'Codex')"
    ).run();
    for (const [tokenHash, connectionId] of [
      ["token-oldest", "connection-oldest"],
      ["token-middle", "connection-middle"],
      ["token-newest", "connection-newest"]
    ]) {
      await env.AUTH_DB.prepare(
        `INSERT INTO auth_mcp_refresh_tokens (
          token_hash, oauth_client_id, connection_id, user_id, expires_at
        ) VALUES (?, 'oauth-codex', ?, ?, datetime('now', '+7 days'))`
      ).bind(tokenHash, connectionId, userId).run();
    }
    const firstCode = await createMcpDeviceCode(env, {
      agentType: "claude-code",
      displayName: "Claude One"
    });
    const secondCode = await createMcpDeviceCode(env, {
      agentType: "claude-code",
      displayName: "Claude Two"
    });

    const approvals = await Promise.all([
      approveMcpDeviceCode(env, firstCode.userCode, { id: userId, name: "At Limit" }),
      approveMcpDeviceCode(env, secondCode.userCode, { id: userId, name: "At Limit" })
    ]);
    const rows = await env.AUTH_DB
      .prepare("SELECT id, status, revoked_at AS revokedAt FROM auth_mcp_connections WHERE user_id = ? ORDER BY id")
      .bind(userId)
      .all();
    const active = rows.results.filter((row) => row.status === "active");
    const revoked = rows.results.filter((row) => row.status === "revoked");

    assert.deepEqual(
      approvals.map((approval) => approval.autoRevokedConnectionId).sort(),
      ["connection-middle", "connection-oldest"]
    );
    assert.equal(active.length, 3);
    assert.equal(revoked.length, 2);
    assert.deepEqual(revoked.map((row) => row.id), ["connection-middle", "connection-oldest"]);
    assert.ok(revoked.every((row) => row.revokedAt));
    assert.equal(rows.results.length, 5);
    assert.ok(approvals.every((approval) => active.some((row) => row.id === approval.connectionId)));
    const refreshRows = await env.AUTH_DB.prepare(
      "SELECT token_hash AS tokenHash, status FROM auth_mcp_refresh_tokens ORDER BY token_hash"
    ).all();
    assert.deepEqual(
      refreshRows.results.map((row) => [row.tokenHash, row.status]),
      [["token-middle", "revoked"], ["token-newest", "active"], ["token-oldest", "revoked"]]
    );
  });

  it("claims an MCP device code only once under concurrent approval", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };
    env.MCP_RESOURCE_URL = "https://mcp.example.invalid";
    await ensureMcpClient(env);
    const code = await createMcpDeviceCode(env, {
      agentType: "codex",
      displayName: "Concurrent Codex"
    });
    const user = { id: "user-device-race", name: "Device Race" };

    const attempts = await Promise.allSettled([
      approveMcpDeviceCode(env, code.userCode, user),
      approveMcpDeviceCode(env, code.userCode, user)
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    const connections = await env.AUTH_DB
      .prepare("SELECT id, status FROM auth_mcp_connections WHERE user_id = ?")
      .bind(user.id)
      .all();

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.status, 409);
    assert.equal(rejected[0].reason.code, "mcp_device_code_approved");
    assert.equal(connections.results.length, 1);
    assert.equal(connections.results[0].id, fulfilled[0].value.connectionId);
    assert.equal(connections.results[0].status, "active");
  });

  it("removes obsolete Knowledge Skill and admin scopes from active and pending MCP grants", async () => {
    const env = { AUTH_DB: createAuthDb(), LEGACY_WORKSPACE_DIRECTORY: "1" };
    const staleScopes = ["workspace:knowledge:read", "workspace:knowledge:skill", "workspace:knowledge:admin"];
    await env.AUTH_DB
      .prepare("INSERT INTO auth_mcp_clients (id, allowed_scopes_json) VALUES (?, ?)")
      .bind("workspace-ai-mcp", JSON.stringify(staleScopes))
      .run();
    await env.AUTH_DB
      .prepare(
        "INSERT INTO auth_mcp_device_codes (device_code, user_code, client_id, agent_type, requested_scopes_json, status, expires_at) VALUES (?, ?, ?, 'codex', ?, 'pending', ?)"
      )
      .bind("device-stale", "STALE001", "workspace-ai-mcp", JSON.stringify(staleScopes), new Date(Date.now() + 60_000).toISOString())
      .run();
    await env.AUTH_DB
      .prepare("INSERT INTO auth_mcp_connections (id, client_id, user_id, agent_type, scopes_json) VALUES (?, ?, ?, 'codex', ?)")
      .bind("connection-stale", "workspace-ai-mcp", "user-stale", JSON.stringify(staleScopes))
      .run();
    await env.AUTH_DB
      .prepare("INSERT INTO auth_resource_clients (id, allowed_scopes_json) VALUES (?, ?)")
      .bind("workspace-knowledge", JSON.stringify(staleScopes))
      .run();

    const migration = readFileSync("workers/auth/db/migrations/20260714_remove_mcp_knowledge_skill_scope.sql", "utf8");
    env.AUTH_DB.database.exec(migration);
    env.AUTH_DB.database.exec(migration);

    const client = await env.AUTH_DB.prepare("SELECT allowed_scopes_json FROM auth_mcp_clients WHERE id = ?").bind("workspace-ai-mcp").first();
    const pending = await env.AUTH_DB.prepare("SELECT requested_scopes_json FROM auth_mcp_device_codes WHERE device_code = ?").bind("device-stale").first();
    const connection = await env.AUTH_DB.prepare("SELECT scopes_json FROM auth_mcp_connections WHERE id = ?").bind("connection-stale").first();
    const resource = await env.AUTH_DB.prepare("SELECT allowed_scopes_json FROM auth_resource_clients WHERE id = ?").bind("workspace-knowledge").first();

    assert.deepEqual(JSON.parse(client.allowed_scopes_json), ["workspace:knowledge:read"]);
    assert.deepEqual(JSON.parse(pending.requested_scopes_json), ["workspace:knowledge:read"]);
    assert.deepEqual(JSON.parse(connection.scopes_json), ["workspace:knowledge:read"]);
    assert.deepEqual(JSON.parse(resource.allowed_scopes_json), ["workspace:knowledge:read", "workspace:knowledge:admin"]);
  });
});


it("fresh installations never infer memberships or merge accounts by email prefix", async () => {
  const env = { AUTH_DB: createAuthDb() };
  await upsertAuthDepartment(env, { id: "dept-old", name: "Workspace Wealth", externalId: "Workspace Wealth", path: ["dept-old"] });
  assert.equal(await resolveAuthDepartmentHierarchy(env, "IT", { email: "person@example.invalid" }), undefined);
  await upsertAuthUserSnapshot(env, { id: "other-person", email: "person@old.example", name: "Person", role: "admin", status: "active" });
  const plan = await planAuthLoginUser(env, { id: "new-person", email: "person@new.example", name: "Person", role: "member", provider: "microsoft_entra_id", providerSubject: "new-subject" });
  assert.equal(plan.kind, "confirmation_required");
  assert.equal(plan.reason, "unmatched_entra_user");
  assert.deepEqual(plan.candidates.map(item => item.id), []);
  await assert.rejects(resolveAuthLoginUser(env, { id: "new-person", email: "person@new.example", name: "Person", role: "member", confirmedUserId: "other-person" }), error => error.status === 428);
});

for(const email of ['member@example.test','member@another.example']) it(`Entra identity ${email} must be explicitly linked before login`, async()=>{
 const env={AUTH_DB:createAuthDb()};
 await upsertAuthUserSnapshot(env,{id:'member',email:'member@example.test',role:'admin',status:'active'});
 const input={id:'provider-id',email,provider:'microsoft_entra_id',providerSubject:'provider-id'};
 assert.deepEqual(await planAuthLoginUser(env,input),{kind:'confirmation_required',candidates:[],reason:'unmatched_entra_user'});
 await assert.rejects(resolveAuthLoginUser(env,{...input,confirmedUserId:'member',allowUninvitedLogin:true}),error=>error.status===428);
 const stored=(await listAuthUsers(env,{search:'member@example.test'}))[0];assert.equal(stored.role,'admin');assert.equal(stored.providerSubject,undefined);
});
