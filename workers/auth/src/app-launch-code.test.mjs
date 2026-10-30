import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import worker from "./index.ts";
import { upsertAuthDepartment, upsertAuthUserSnapshot } from "./repository.ts";
import { signAuthToken } from "./token.ts";

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database.prepare(sql));
  }

  async batch(statements) {
    return statements.map((statement) => statement.run());
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
    const result = this.statement.run(...this.params);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

function createAuthDb() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/auth/db/schema.sql", "utf8"));
  database.prepare("UPDATE auth_login_email_policy SET allowed_domains_json = ? WHERE id = 1").run(JSON.stringify(["example.invalid", "example.test"]));
  return new D1Adapter(database);
}

function createEnv() {
  return {
    AUTH_CODE_TTL_SECONDS: "120",
    AUTH_DB: createAuthDb(),
    AUTH_ISSUER: "https://auth.workspace.internal",
    AUTH_JWT_SECRET: "test-secret",
    AUTH_SERVICE_TOKEN: "service-token"
  };
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

async function inspectAccessResult(env, result) {
  const response = await worker.fetch(new Request(
    `https://auth.test/auth/access/result?result=${encodeURIComponent(result)}`
  ), env);
  assert.equal(response.status, 200);
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
      id: "app-ops",
      name: "Ops App",
      status: "listed",
      sdkStatus: "connected",
      accessMode: "public",
      callbackUrls: ["https://ops.example.com/auth/workspace/callback"],
      launchUrl: "https://ops.example.com",
      appSecret: "app-launch-test-client-secret-at-least-32",
      ...overrides
    })
  }), env);

  assert.equal(response.status, 201);
}

async function authorize(env) {
  await upsertAuthUserSnapshot(env, {
    email: "test.user@example.invalid",
    id: "user-1",
    name: "Ada Zhang",
    role: "member",
    status: "active"
  });
  const session = await signAuthToken(env, {
    typ: "workspace_session",
    sub: "user-1",
    oid: "user-1",
    email: "test.user@example.invalid",
    name: "Ada Zhang",
    role: "member",
    authenticationMethod: "microsoft_entra_id",
    amr: ["microsoft_entra_id"],
    exp: Math.floor(Date.now() / 1000) + 600
  });
  const response = await worker.fetch(new Request("https://auth.test/v1/authorize?app_id=app-ops&redirect_uri=https%3A%2F%2Fops.example.com%2Fauth%2Fworkspace%2Fcallback&redirect_url=https%3A%2F%2Fops.example.com%2Fdashboard", {
    headers: {
      cookie: `workspace_session=${encodeURIComponent(session)}`
    }
  }), env);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const location = response.headers.get("location");
  assert.ok(location);
  const callback = new URL(location);
  assert.equal(callback.origin, "https://ops.example.com");
  assert.equal(callback.pathname, "/auth/workspace/callback");
  assert.equal(callback.searchParams.get("app_id"), "app-ops");
  assert.ok(callback.searchParams.get("code"));
  assert.equal(callback.searchParams.get("redirect_url"), "https://ops.example.com/dashboard");
  return callback.searchParams.get("code");
}

async function signedSession(env, overrides = {}) {
  const user = {
    email: "test.user@example.invalid",
    id: "user-1",
    name: "Ada Zhang",
    role: "member",
    status: "active",
    ...overrides
  };
  await upsertAuthUserSnapshot(env, user);
  return signAuthToken(env, {
    typ: "workspace_session",
    sub: user.id,
    oid: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    authenticationMethod: "microsoft_entra_id",
    amr: ["microsoft_entra_id"],
    exp: Math.floor(Date.now() / 1000) + 600
  });
}

function basic(secret = "app-launch-test-client-secret-at-least-32") {
  return `Basic ${btoa(`app-ops:${secret}`)}`;
}

describe("app launch authorization code", () => {
  it("serves the active department catalog only to a service client", async () => {
    const env = createEnv();
    await upsertAuthDepartment(env, { id: "dept-root", name: "Workspace Wealth Group Limited", path: ["dept-root"], source: "moka" });
    await upsertAuthDepartment(env, { id: "dept-group", name: "Group", parentId: "dept-root", path: ["dept-root", "dept-group"], source: "moka" });

    const denied = await worker.fetch(new Request("https://auth.test/v1/admin/departments"), env);
    assert.equal(denied.status, 401);

    const response = await worker.fetch(new Request("https://auth.test/v1/admin/departments", {
      headers: { authorization: "Bearer service-token" }
    }), env);
    assert.equal(response.status, 200);
    assert.deepEqual((await readJson(response)).departments.map((item) => item.name), ["Workspace Wealth Group Limited", "Group"]);
  });

  it("adds a display-only Moka path to an authoritative browser session", async () => {
    const env = createEnv();
    await upsertAuthDepartment(env, { id: "dept-root", name: "Workspace Wealth Group Limited", path: ["dept-root"], source: "moka" });
    await upsertAuthDepartment(env, { id: "dept-group", name: "Group", parentId: "dept-root", path: ["dept-root", "dept-group"], source: "moka" });
    await upsertAuthDepartment(env, { id: "dept-ai", name: "AI Adoption", parentId: "dept-group", path: ["dept-root", "dept-group", "dept-ai"], source: "moka" });
    await upsertAuthUserSnapshot(env, {
      id: "user-moka",
      email: "moka@example.test",
      name: "Moka User",
      source: "moka",
      department: "AI Adoption",
      departmentId: "dept-ai",
      departmentPath: ["dept-root", "dept-group", "dept-ai"]
    });
    const session = await signAuthToken(env, {
      typ: "workspace_session",
      sub: "user-moka",
      email: "moka@example.test",
      exp: Math.floor(Date.now() / 1000) + 600
    });
    const response = await worker.fetch(new Request("https://auth.test/auth/session", {
      headers: { cookie: `workspace_session=${encodeURIComponent(session)}` }
    }), env);
    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.equal(payload.user.department, "AI Adoption");
    assert.equal(payload.user.departmentDisplayPath, "Workspace Wealth Group Limited/Group/AI Adoption");
    assert.deepEqual(payload.user.departmentPath, ["dept-root", "dept-group", "dept-ai"]);
  });


  it("requires every registered App to have a strong confidential client secret", async () => {
    const env = createEnv();
    for (const [appSecret, error] of [[undefined, "app_client_secret_required"], ["too-short", "weak_app_client_secret"]]) {
      const response = await worker.fetch(new Request("https://auth.test/v1/admin/apps", {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          accessMode: "public",
          appSecret,
          id: `app-${error}`,
          name: "Invalid Client"
        })
      }), env);
      assert.equal(response.status, 400);
      assert.equal((await readJson(response)).error, error);
    }
  });

  it("uses the current Auth directory role and rejects a suspended stale session", async () => {
    const env = createEnv();
    await upsertAuthUserSnapshot(env, {
      email: "demoted.user@example.invalid",
      id: "demoted-user",
      name: "Demoted User",
      role: "member",
      status: "active"
    });
    const staleAdminSession = await signAuthToken(env, {
      typ: "workspace_session",
      sub: "demoted-user",
      oid: "demoted-user",
      email: "demoted.user@example.invalid",
      name: "Demoted User",
      role: "admin",
      status: "active",
      exp: Math.floor(Date.now() / 1000) + 600
    });

    const demotedResponse = await worker.fetch(new Request("https://auth.test/auth/session", {
      headers: { cookie: `workspace_session=${encodeURIComponent(staleAdminSession)}` }
    }), env);
    const demoted = await readJson(demotedResponse);
    assert.equal(demoted.authenticated, true);
    assert.equal(demoted.user.role, "member");

    await upsertAuthUserSnapshot(env, {
      email: "demoted.user@example.invalid",
      id: "demoted-user",
      name: "Demoted User",
      role: "member",
      status: "suspended"
    });
    const suspendedResponse = await worker.fetch(new Request("https://auth.test/auth/session", {
      headers: { cookie: `workspace_session=${encodeURIComponent(staleAdminSession)}` }
    }), env);
    const suspended = await readJson(suspendedResponse);
    assert.equal(suspended.authenticated, false);
    assert.equal(suspended.user, undefined);
  });

  it("does not recreate a deleted Auth user from a still-valid stale session", async () => {
    const env = createEnv();
    await upsertAuthUserSnapshot(env, {
      email: "deleted.user@example.invalid",
      id: "deleted-user",
      name: "Deleted User",
      role: "admin",
      status: "active"
    });
    const staleSession = await signAuthToken(env, {
      typ: "workspace_session",
      sub: "deleted-user",
      oid: "deleted-user",
      email: "deleted.user@example.invalid",
      name: "Deleted User",
      role: "admin",
      status: "active",
      exp: Math.floor(Date.now() / 1000) + 600
    });
    await env.AUTH_DB.prepare("DELETE FROM auth_users WHERE id = ?").bind("deleted-user").run();

    const response = await worker.fetch(new Request("https://auth.test/auth/session", {
      headers: { cookie: `workspace_session=${encodeURIComponent(staleSession)}` }
    }), env);
    const payload = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(payload.authenticated, false);
    assert.equal(await env.AUTH_DB.prepare("SELECT id FROM auth_users WHERE id = ?").bind("deleted-user").first(), null);
  });

  it("does not let a stale service snapshot reactivate or re-elevate a canonical Auth user", async () => {
    const env = createEnv();
    await registerApp(env);
    await upsertAuthUserSnapshot(env, {
      email: "suspended.user@example.invalid",
      id: "suspended-user",
      name: "Suspended User",
      role: "member",
      status: "suspended"
    });

    const response = await worker.fetch(new Request("https://auth.test/v1/app-login/direct-jump", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        appId: "app-ops",
        user: {
          email: "suspended.user@example.invalid",
          id: "suspended-user",
          name: "Suspended User",
          role: "admin",
          status: "active"
        }
      })
    }), env);
    const payload = await readJson(response);

    assert.equal(response.status, 403);
    assert.equal(payload.error, "denied_user_inactive");
    const stored = await env.AUTH_DB
      .prepare("SELECT role, status FROM auth_users WHERE id = ?")
      .bind("suspended-user")
      .first();
    assert.equal(stored.role, "member");
    assert.equal(stored.status, "suspended");
  });

  it("does not let service-supplied App or Grant snapshots override canonical Auth policy", async () => {
    const env = createEnv();
    await registerApp(env, { status: "draft" });
    await upsertAuthUserSnapshot(env, {
      email: "service.user@example.invalid",
      id: "service-user",
      name: "Service User",
      role: "member",
      status: "active"
    });

    const response = await worker.fetch(new Request("https://auth.test/v1/app-login/direct-jump", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        appId: "app-ops",
        app: {
          id: "app-ops",
          status: "listed",
          accessMode: "public",
          callbackUrls: ["https://ops.example.com/auth/workspace/callback"],
          launchUrl: "https://ops.example.com"
        },
        grantStatus: "approved",
        user: { id: "service-user", role: "admin", status: "active" }
      })
    }), env);

    assert.equal(response.status, 403);
    assert.equal((await readJson(response)).error, "denied_app_not_listed");
  });

  it("rejects public identity headers on the legacy service session endpoint", async () => {
    const env = createEnv();
    const forgedHeaders = {
      "x-workspace-user-email": "admin@example.invalid",
      "x-workspace-user-id": "forged-admin",
      "x-workspace-role": "admin"
    };

    const publicResponse = await worker.fetch(new Request("https://auth.test/v1/session", {
      headers: forgedHeaders
    }), env);
    assert.equal(publicResponse.status, 401);
    assert.equal((await readJson(publicResponse)).error, "invalid_service_token");

    const serviceResponse = await worker.fetch(new Request("https://auth.test/v1/session", {
      headers: {
        ...forgedHeaders,
        authorization: "Bearer service-token"
      }
    }), env);
    assert.equal(serviceResponse.status, 200);
    const servicePayload = await readJson(serviceResponse);
    assert.equal(servicePayload.user.id, "forged-admin");
    assert.equal(servicePayload.user.role, "admin");
  });

  it("accepts the dedicated APPS service token for app and App MCP resource registration", async () => {
    const env = createEnv();
    delete env.AUTH_SERVICE_TOKEN;
    env.APPS_AUTH_SERVICE_TOKEN = "apps-service-token";

    const response = await worker.fetch(new Request("https://auth.test/v1/admin/apps", {
      method: "POST",
      headers: {
        authorization: "Bearer apps-service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        accessMode: "public",
        appSecret: "apps-registration-test-secret-at-least-32",
        id: "app-apps-token",
        name: "APPS Token App"
      })
    }), env);

    assert.equal(response.status, 201);
    const payload = await readJson(response);
    assert.equal(payload.app.id, "app-apps-token");

    const resourceResponse = await worker.fetch(new Request("https://auth.test/v1/admin/resources", {
      method: "POST",
      headers: {
        authorization: "Bearer apps-service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        accessMode: "public",
        allowedScopes: ["app:mcp:discover", "academy:read"],
        audience: "https://academy.example.test",
        id: "app-mcp:app-apps-token",
        name: "APPS Token App MCP Resource"
      })
    }), env);
    assert.equal(resourceResponse.status, 201);

    const adminUsersResponse = await worker.fetch(new Request("https://auth.test/v1/admin/users", {
      headers: { authorization: "Bearer apps-service-token" }
    }), env);
    assert.equal(adminUsersResponse.status, 503);
  });

  it("scopes the dedicated Publication token to app and resource publication", async () => {
    const env = createEnv();
    delete env.AUTH_SERVICE_TOKEN;
    env.PUBLICATION_AUTH_SERVICE_TOKEN = "publication-service-token";

    const appResponse = await worker.fetch(new Request("https://auth.test/v1/admin/apps", {
      method: "POST",
      headers: {
        authorization: "Bearer publication-service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        accessMode: "public",
        appSecret: "publication-registration-test-secret-at-least-32",
        id: "app-publication-token",
        name: "Publication Token App"
      })
    }), env);
    assert.equal(appResponse.status, 201);

    const resourceResponse = await worker.fetch(new Request("https://auth.test/v1/admin/resources", {
      method: "POST",
      headers: {
        authorization: "Bearer publication-service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        accessMode: "public",
        allowedScopes: ["knowledge:read"],
        audience: "https://knowledge.example.test",
        id: "resource-publication-token",
        name: "Publication Token Resource"
      })
    }), env);
    assert.equal(resourceResponse.status, 201);

    const adminUsersResponse = await worker.fetch(new Request("https://auth.test/v1/admin/users", {
      headers: { authorization: "Bearer publication-service-token" }
    }), env);
    assert.equal(adminUsersResponse.status, 503);
  });

  it("accepts the dedicated Portal token for Portal service endpoints", async () => {
    const env = createEnv();
    delete env.AUTH_SERVICE_TOKEN;
    env.PORTAL_AUTH_SERVICE_TOKEN = "portal-service-token";

    const response = await worker.fetch(new Request("https://auth.test/v1/session", {
      headers: {
        authorization: "Bearer portal-service-token",
        "x-workspace-user-email": "admin@example.invalid",
        "x-workspace-user-id": "portal-admin",
        "x-workspace-role": "admin"
      }
    }), env);

    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.equal(payload.user.id, "portal-admin");
    assert.equal(payload.user.role, "admin");
  });

  it("updates the canonical Auth role for Portal user-role changes", async () => {
    const env = createEnv();
    const session = await signedSession(env);
    const response = await worker.fetch(new Request("https://auth.test/v1/admin/users/user-1/role", {
      method: "PATCH",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ role: "admin" })
    }), env);

    assert.equal(response.status, 200);
    assert.equal((await readJson(response)).user.role, "admin");

    const sessionResponse = await worker.fetch(new Request("https://auth.test/auth/session", {
      headers: { cookie: `workspace_session=${encodeURIComponent(session)}` }
    }), env);
    assert.equal(sessionResponse.status, 200);
    assert.equal((await readJson(sessionResponse)).user.role, "admin");
  });

  it("does not trust caller-supplied identity headers on browser authorize", async () => {
    const env = createEnv();
    await registerApp(env);
    const response = await worker.fetch(new Request(
      "https://auth.test/v1/authorize?app_id=app-ops&redirect_uri=https%3A%2F%2Fops.example.com%2Fauth%2Fworkspace%2Fcallback",
      {
        headers: {
          "x-workspace-user-id": "forged-admin",
          "x-workspace-user-email": "admin@example.invalid",
          "x-workspace-role": "admin"
        }
      }
    ), env);

    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location"));
    assert.equal(location.origin, "https://auth.workspace.internal");
    assert.equal(location.pathname, "/");
    const returnTo = new URL(location.searchParams.get("return_to"));
    assert.equal(returnTo.origin, "https://auth.workspace.internal");
    assert.equal(returnTo.pathname, "/auth/v1/authorize");
    assert.equal(returnTo.searchParams.get("app_id"), "app-ops");
  });

  it("requires an exact registered callback including its query string", async () => {
    const env = createEnv();
    await registerApp(env, {
      callbackUrls: ["https://ops.example.com/auth/workspace/callback?tenant=registered"]
    });
    const session = await signedSession(env);
    const response = await worker.fetch(new Request(
      "https://auth.test/v1/authorize?app_id=app-ops"
        + "&redirect_uri=https%3A%2F%2Fops.example.com%2Fauth%2Fworkspace%2Fcallback%3Ftenant%3Dattacker"
        + "&redirect_url=https%3A%2F%2Fops.example.com%2Fdashboard",
      { headers: { cookie: `workspace_session=${encodeURIComponent(session)}` } }
    ), env);

    assert.equal(response.status, 400);
    assert.equal((await readJson(response)).error, "callback_not_allowed");
  });

  it("redirects a browser access denial to the shared Portal page with a signed public result", async () => {
    const env = createEnv();
    await registerApp(env, { accessMode: "targeted", accessTargets: [] });
    const session = await signedSession(env);
    const redirectUrl = "https://ops.example.com/dashboard?workspace_auth_state=browser-state";
    const response = await worker.fetch(new Request(
      "https://auth.test/v1/authorize?app_id=app-ops"
        + "&redirect_uri=https%3A%2F%2Fops.example.com%2Fauth%2Fworkspace%2Fcallback"
        + `&redirect_url=${encodeURIComponent(redirectUrl)}`,
      { headers: { cookie: `workspace_session=${encodeURIComponent(session)}` } }
    ), env);

    assert.equal(response.status, 302);
    const accessPage = new URL(response.headers.get("location"));
    assert.equal(accessPage.origin, "https://auth.workspace.internal");
    assert.equal(accessPage.pathname, "/auth/access");
    const result = accessPage.searchParams.get("result");
    assert.ok(result);

    const inspected = await inspectAccessResult(env, result);
    assert.equal(inspected.valid, true);
    assert.equal(inspected.code, "ACCESS_NOT_GRANTED");
    assert.equal(inspected.app.id, "app-ops");
    assert.equal(inspected.app.name, "Ops App");
    assert.ok(inspected.requestId);
    assert.equal(JSON.stringify(inspected).includes("denied_not_targeted"), false);
  });

  it("authorizes an explicit collaborator to preview a connected draft App", async () => {
    const env = createEnv();
    await registerApp(env, {
      accessMode: "targeted",
      accessTargets: ["user:user-1"],
      sdkStatus: "connected",
      status: "draft"
    });
    const session = await signedSession(env);
    const response = await worker.fetch(new Request(
      "https://auth.test/v1/authorize?app_id=app-ops&redirect_uri=https%3A%2F%2Fops.example.com%2Fauth%2Fworkspace%2Fcallback",
      { headers: { cookie: `workspace_session=${encodeURIComponent(session)}` } }
    ), env);

    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location"));
    assert.equal(location.origin, "https://ops.example.com");
    assert.equal(location.pathname, "/auth/workspace/callback");
    assert.ok(location.searchParams.get("code"));
  });

  it("uses the canonical admin role only for pre-listing App inspection", async () => {
    const env = createEnv();
    await registerApp(env, {
      accessMode: "targeted",
      accessTargets: [],
      sdkStatus: "pending",
      status: "draft"
    });
    await upsertAuthUserSnapshot(env, {
      email: "otp.admin@example.invalid",
      id: "otp-admin",
      name: "OTP Admin",
      role: "admin",
      status: "active"
    });
    const session = await signAuthToken(env, {
      typ: "workspace_session",
      sub: "otp-admin",
      oid: "otp-admin",
      email: "otp.admin@example.invalid",
      name: "OTP Admin",
      role: "member",
      authenticationMethod: "email_otp",
      amr: ["email_otp"],
      exp: Math.floor(Date.now() / 1000) + 600
    });

    const response = await worker.fetch(new Request(
      "https://auth.test/v1/authorize?app_id=app-ops&redirect_uri=https%3A%2F%2Fops.example.com%2Fauth%2Fworkspace%2Fcallback",
      {
        headers: {
          cookie: `workspace_session=${encodeURIComponent(session)}`
        }
      }
    ), env);

    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location"));
    assert.equal(location.origin, "https://ops.example.com");
    assert.equal(location.pathname, "/auth/workspace/callback");
    assert.ok(location.searchParams.get("code"));
  });

  it("does not let a canonical admin bypass targeted access after listing", async () => {
    const env = createEnv();
    await registerApp(env, {
      accessMode: "targeted",
      accessTargets: []
    });
    await upsertAuthUserSnapshot(env, {
      email: "listed.admin@example.invalid",
      id: "listed-admin",
      name: "Listed App Admin",
      role: "admin",
      status: "active"
    });
    const session = await signAuthToken(env, {
      typ: "workspace_session",
      sub: "listed-admin",
      oid: "listed-admin",
      email: "listed.admin@example.invalid",
      name: "Listed App Admin",
      role: "admin",
      exp: Math.floor(Date.now() / 1000) + 600
    });

    const response = await worker.fetch(new Request(
      "https://auth.test/v1/authorize?app_id=app-ops&redirect_uri=https%3A%2F%2Fops.example.com%2Fauth%2Fworkspace%2Fcallback",
      { headers: { cookie: `workspace_session=${encodeURIComponent(session)}` } }
    ), env);

    assert.equal(response.status, 302);
    const accessPage = new URL(response.headers.get("location"));
    assert.equal(accessPage.origin, "https://auth.workspace.internal");
    assert.equal(accessPage.pathname, "/auth/access");
    const inspected = await inspectAccessResult(env, accessPage.searchParams.get("result"));
    assert.equal(inspected.code, "ACCESS_NOT_GRANTED");
  });

  it("accepts a valid legacy signed session without authentication-method metadata", async () => {
    const env = createEnv();
    await registerApp(env);
    await upsertAuthUserSnapshot(env, {
      email: "legacy.user@example.invalid",
      id: "legacy-user",
      name: "Legacy User",
      role: "member",
      status: "active"
    });
    const session = await signAuthToken(env, {
      typ: "workspace_session",
      sub: "legacy-user",
      oid: "legacy-user",
      email: "legacy.user@example.invalid",
      name: "Legacy User",
      role: "member",
      exp: Math.floor(Date.now() / 1000) + 600
    });

    const response = await worker.fetch(new Request(
      "https://auth.test/v1/authorize?app_id=app-ops&redirect_uri=https%3A%2F%2Fops.example.com%2Fauth%2Fworkspace%2Fcallback",
      { headers: { cookie: `workspace_session=${encodeURIComponent(session)}` } }
    ), env);

    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location"));
    assert.equal(location.origin, "https://ops.example.com");
    assert.equal(location.pathname, "/auth/workspace/callback");
    assert.ok(location.searchParams.get("code"));
  });

  it("exchanges a callback code once with app client authentication", async () => {
    const env = createEnv();
    await registerApp(env);
    const code = await authorize(env);

    const exchangeResponse = await worker.fetch(new Request("https://auth.test/v1/app-login/exchange", {
      method: "POST",
      headers: {
        authorization: basic(),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        appId: "app-ops",
        code,
        redirectUri: "https://ops.example.com/auth/workspace/callback"
      })
    }), env);
    const exchange = await readJson(exchangeResponse);

    assert.equal(exchangeResponse.status, 200);
    assert.equal(exchange.valid, true);
    assert.equal(exchange.appId, "app-ops");
    assert.equal(exchange.user.id, "user-1");
    assert.equal(exchange.redirectUrl, "https://ops.example.com/dashboard");

    const replayResponse = await worker.fetch(new Request("https://auth.test/v1/app-login/exchange", {
      method: "POST",
      headers: {
        authorization: basic(),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        appId: "app-ops",
        code,
        redirectUri: "https://ops.example.com/auth/workspace/callback"
      })
    }), env);
    const replay = await readJson(replayResponse);

    assert.equal(replayResponse.status, 409);
    assert.equal(replay.error, "launch_code_already_consumed");
  });

  it("atomically lets exactly one concurrent exchange consume a launch code", async () => {
    const env = createEnv();
    await registerApp(env);
    const code = await authorize(env);
    const exchange = () => worker.fetch(new Request("https://auth.test/v1/app-login/exchange", {
      method: "POST",
      headers: {
        authorization: basic(),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        appId: "app-ops",
        code,
        redirectUri: "https://ops.example.com/auth/workspace/callback"
      })
    }), env);

    const responses = await Promise.all([exchange(), exchange()]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const rejected = responses.find((response) => response.status === 409);
    assert.equal((await readJson(rejected)).error, "launch_code_already_consumed");
  });

  it("re-evaluates canonical user status after code issuance and before exchange", async () => {
    const env = createEnv();
    await registerApp(env);
    const code = await authorize(env);
    await upsertAuthUserSnapshot(env, {
      email: "test.user@example.invalid",
      id: "user-1",
      name: "Ada Zhang",
      role: "member",
      status: "suspended"
    });

    const response = await worker.fetch(new Request("https://auth.test/v1/app-login/exchange", {
      method: "POST",
      headers: {
        authorization: basic(),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        appId: "app-ops",
        code,
        redirectUri: "https://ops.example.com/auth/workspace/callback"
      })
    }), env);

    assert.equal(response.status, 403);
    const denied = await readJson(response);
    assert.equal(denied.error, "access_denied");
    assert.ok(denied.accessResult);
    assert.equal((await inspectAccessResult(env, denied.accessResult)).code, "USER_INACTIVE");
  });

  it("does not recreate a deleted Auth user from an issued launch code", async () => {
    const env = createEnv();
    await registerApp(env);
    const code = await authorize(env);
    await env.AUTH_DB.prepare("DELETE FROM auth_users WHERE id = ?").bind("user-1").run();

    const response = await worker.fetch(new Request("https://auth.test/v1/app-login/exchange", {
      method: "POST",
      headers: {
        authorization: basic(),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        clientId: "app-ops",
        code,
        redirectUri: "https://ops.example.com/auth/workspace/callback"
      })
    }), env);

    assert.equal(response.status, 403);
    const denied = await readJson(response);
    assert.equal(denied.error, "access_denied");
    assert.ok(denied.accessResult);
    assert.equal((await inspectAccessResult(env, denied.accessResult)).code, "USER_INACTIVE");
    assert.equal(await env.AUTH_DB.prepare("SELECT id FROM auth_users WHERE id = ?").bind("user-1").first(), null);
  });

  it("rejects invalid app client credentials before consuming the code", async () => {
    const env = createEnv();
    await registerApp(env);
    const code = await authorize(env);

    const badSecretResponse = await worker.fetch(new Request("https://auth.test/v1/app-login/exchange", {
      method: "POST",
      headers: {
        authorization: basic("wrong-secret"),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        appId: "app-ops",
        code,
        redirectUri: "https://ops.example.com/auth/workspace/callback"
      })
    }), env);
    const badSecret = await readJson(badSecretResponse);

    assert.equal(badSecretResponse.status, 401);
    assert.equal(badSecret.error, "invalid_app_client_authentication");

    const exchangeResponse = await worker.fetch(new Request("https://auth.test/v1/app-login/exchange", {
      method: "POST",
      headers: {
        authorization: basic(),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        appId: "app-ops",
        code,
        redirectUri: "https://ops.example.com/auth/workspace/callback"
      })
    }), env);

    assert.equal(exchangeResponse.status, 200);
  });

  it("serves an App-policy-filtered organization directory with App client authentication", async () => {
    const env = createEnv();
    await registerApp(env, {
      accessMode: "targeted",
      accessTargets: ["department:dept-investment"],
      collaboratorUserIds: ["user-research"],
      systemRolePolicyVersion: "2026-08-17T09:30:00.000Z"
    });
    await upsertAuthDepartment(env, {
      id: "dept-investment",
      name: "Investment",
      path: ["dept-investment"]
    });
    await upsertAuthDepartment(env, {
      id: "dept-research",
      name: "Research",
      parentId: "dept-investment",
      path: ["dept-investment", "dept-research"]
    });
    await upsertAuthDepartment(env, {
      id: "dept-hr",
      name: "HR",
      path: ["dept-hr"]
    });
    await upsertAuthUserSnapshot(env, {
      department: "Investment / Research",
      departmentId: "dept-research",
      departmentPath: ["dept-investment", "dept-research"],
      email: "researcher@example.invalid",
      id: "user-research",
      name: "Research User",
      role: "member",
      status: "active"
    });
    await upsertAuthUserSnapshot(env, {
      department: "HR",
      departmentId: "dept-hr",
      departmentPath: ["dept-hr"],
      email: "hr@example.invalid",
      id: "user-hr",
      name: "HR User",
      role: "member",
      status: "active"
    });

    const departmentsResponse = await worker.fetch(new Request("https://auth.test/v1/app-directory/departments", {
      headers: { authorization: basic() }
    }), env);
    const departments = await readJson(departmentsResponse);
    assert.equal(departmentsResponse.status, 200);
    assert.equal(departments.directoryReadScope, "app");
    assert.equal(departments.policyFiltered, true);
    assert.deepEqual(departments.departments.map((department) => department.id), ["dept-investment", "dept-research"]);

    const peopleResponse = await worker.fetch(new Request(
      "https://auth.test/v1/app-directory/people?departmentId=dept-investment&includeDescendants=true",
      { headers: { authorization: basic() } }
    ), env);
    const people = await readJson(peopleResponse);
    assert.equal(peopleResponse.status, 200);
    assert.deepEqual(people.people.map((person) => person.id), ["user-research"]);
    assert.equal(Object.hasOwn(people.people[0], "role"), false);
    assert.equal(Object.hasOwn(people.people[0], "identityProvider"), false);

    const hiddenPersonResponse = await worker.fetch(new Request(
      "https://auth.test/v1/app-directory/people/user-hr",
      { headers: { authorization: basic() } }
    ), env);
    assert.equal(hiddenPersonResponse.status, 404);

    const visiblePersonResponse = await worker.fetch(new Request(
      "https://auth.test/v1/app-directory/people/user-research",
      { headers: { authorization: basic() } }
    ), env);
    const visiblePerson = await readJson(visiblePersonResponse);
    assert.equal(visiblePersonResponse.status, 200);
    assert.equal(visiblePerson.directoryReadScope, "app");
    assert.equal(visiblePerson.person.id, "user-research");

    const checkResponse = await worker.fetch(new Request("https://auth.test/v1/app-directory/access/check", {
      method: "POST",
      headers: {
        authorization: basic(),
        "content-type": "application/json"
      },
      body: JSON.stringify({ userId: "user-hr" })
    }), env);
    const check = await readJson(checkResponse);
    assert.equal(checkResponse.status, 200);
    assert.equal(check.allowed, false);
    assert.equal(check.reason, "denied_not_targeted");

    const collaboratorCheckResponse = await worker.fetch(new Request("https://auth.test/v1/app-directory/access/check", {
      method: "POST",
      headers: {
        authorization: basic(),
        "content-type": "application/json"
      },
      body: JSON.stringify({ userId: "user-research" })
    }), env);
    const collaboratorCheck = await readJson(collaboratorCheckResponse);
    assert.equal(collaboratorCheck.allowed, true);
    assert.deepEqual(collaboratorCheck.systemRoles, ["app_collaborator"]);
    assert.equal(collaboratorCheck.systemRolePolicyVersion, "2026-08-17T09:30:00.000Z");

    const unauthenticated = await worker.fetch(new Request("https://auth.test/v1/app-directory/people", {
      headers: { authorization: basic("wrong-secret") }
    }), env);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await readJson(unauthenticated)).error, "invalid_app_client_authentication");

    await registerApp(env, {
      accessMode: "targeted",
      accessTargets: ["department:dept-investment"],
      directoryReadScope: "company"
    });

    const companyDepartmentsResponse = await worker.fetch(new Request(
      "https://auth.test/v1/app-directory/departments",
      { headers: { authorization: basic() } }
    ), env);
    const companyDepartments = await readJson(companyDepartmentsResponse);
    assert.equal(companyDepartments.directoryReadScope, "company");
    assert.equal(companyDepartments.policyFiltered, false);
    assert.deepEqual(
      companyDepartments.departments.map((department) => department.id),
      ["dept-hr", "dept-investment", "dept-research"]
    );

    const companyPeopleResponse = await worker.fetch(new Request(
      "https://auth.test/v1/app-directory/people?q=hr%40example.invalid",
      { headers: { authorization: basic() } }
    ), env);
    const companyPeople = await readJson(companyPeopleResponse);
    assert.equal(companyPeople.directoryReadScope, "company");
    assert.equal(companyPeople.policyFiltered, false);
    assert.deepEqual(companyPeople.people.map((person) => person.id), ["user-hr"]);

    const companyPersonResponse = await worker.fetch(new Request(
      "https://auth.test/v1/app-directory/people/user-hr",
      { headers: { authorization: basic() } }
    ), env);
    const companyPerson = await readJson(companyPersonResponse);
    assert.equal(companyPersonResponse.status, 200);
    assert.equal(companyPerson.directoryReadScope, "company");
    assert.equal(companyPerson.policyFiltered, false);
    assert.equal(companyPerson.person.id, "user-hr");

    const companyAccessCheckResponse = await worker.fetch(new Request("https://auth.test/v1/app-directory/access/check", {
      method: "POST",
      headers: {
        authorization: basic(),
        "content-type": "application/json"
      },
      body: JSON.stringify({ userId: "user-hr" })
    }), env);
    const companyAccessCheck = await readJson(companyAccessCheckResponse);
    assert.equal(companyAccessCheck.allowed, false);
    assert.equal(companyAccessCheck.reason, "denied_not_targeted");

    await registerApp(env, {
      accessMode: "targeted",
      accessTargets: ["department:dept-investment"]
    });

    const preservedCompanyDirectoryResponse = await worker.fetch(new Request(
      "https://auth.test/v1/app-directory/people?q=hr%40example.invalid",
      { headers: { authorization: basic() } }
    ), env);
    const preservedCompanyDirectory = await readJson(preservedCompanyDirectoryResponse);
    assert.equal(preservedCompanyDirectoryResponse.status, 200);
    assert.equal(preservedCompanyDirectory.directoryReadScope, "company");
    assert.equal(preservedCompanyDirectory.policyFiltered, false);
    assert.deepEqual(preservedCompanyDirectory.people.map((person) => person.id), ["user-hr"]);
  });
});
