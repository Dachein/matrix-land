import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readAuthSession, requireAdminPortalUser, resolveCurrentUser } from "./index.ts";
import { readPortalCurrentUser, updateLastSeenAt } from "./portalUserRepository.ts";

function makeContext(options = {}) {
  return {
    env: options.env ?? {},
    request: new Request("https://portal.test/api/catalog", {
      headers: options.headers
    })
  };
}

describe("identity boundary", () => {
  it("preserves the live default-Agent profile and null through Portal basic info and DB hydration", async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const agent of [{ id: "finance-assistant", name: "小鲸", email: "receipts-assistant@example.invalid" }, null]) {
        globalThis.fetch = async () => Response.json({ authenticated: true, user: {
          id: "user-1", name: "Ada", email: "ada@example.com", role: "member", defaultAgent: agent
        } });
        const context = makeContext({ env: { AUTH_WORKER_URL: "https://auth.example.test" }, headers: { cookie: "workspace_session=session" } });
        const session = await readAuthSession(context);
        assert.deepEqual(session.user.defaultAgent, agent);
        const hydrated = await readPortalCurrentUser(createPortalAdminReadDb(), "user-1", session.user);
        assert.deepEqual(hydrated.defaultAgent, agent);
      }
    } finally { globalThis.fetch = originalFetch; }
  });
  it("refreshes a changed Auth email on the same Portal identity without reactivating inactive users", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT UNIQUE, status TEXT, last_seen_at TEXT, updated_at TEXT); INSERT INTO users(id,email,status) VALUES ('stable-user-id','old.work@example.test','active'),('inactive-user','inactive@example.test','inactive');");
    const db = { prepare(sql) { const statement = sqlite.prepare(sql); return { bind(...args) { return { async run() { return statement.run(...args); } }; } }; } };
    try {
      await updateLastSeenAt(db, "stable-user-id", "new.work@example.test");
      await updateLastSeenAt(db, "inactive-user");
      assert.deepEqual({ ...sqlite.prepare("SELECT id,email,status FROM users WHERE id='stable-user-id'").get() }, {
        id: "stable-user-id", email: "new.work@example.test", status: "active"
      });
      assert.deepEqual({ ...sqlite.prepare("SELECT email,status FROM users WHERE id='inactive-user'").get() }, { email: "inactive@example.test", status: "inactive" });
      await assert.rejects(updateLastSeenAt(db, "stable-user-id", "inactive@example.test"), /UNIQUE/);
      assert.equal(sqlite.prepare("SELECT email FROM users WHERE id='stable-user-id'").get().email, "new.work@example.test");
    } finally { sqlite.close(); }
  });
  it("does not treat missing Auth Worker configuration as an authenticated fallback session", async () => {
    const session = await readAuthSession(makeContext());

    assert.deepEqual(session, {
      configured: false,
      authenticated: false,
      emailLoginConfigured: false,
      emailLoginUrl: "/auth/email/login",
      loginUrl: "/auth/login",
      logoutUrl: "/auth/logout"
    });
  });

  it("forwards the configured email OTP login option for an anonymous session", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://auth.example.test/auth/session");
      assert.equal(init.headers.get("cookie"), null);
      return new Response(JSON.stringify({
        authenticated: false,
        emailLoginConfigured: true,
        emailLoginUrl: "/auth/email/login"
      }), {
        headers: { "content-type": "application/json" }
      });
    };

    try {
      const session = await readAuthSession(makeContext({
        env: { AUTH_WORKER_URL: "https://auth.example.test" }
      }));

      assert.equal(session.authenticated, false);
      assert.equal(session.emailLoginConfigured, true);
      assert.equal(session.emailLoginUrl, "/auth/email/login");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("requires Auth Worker configuration for protected current user resolution", async () => {
    await assert.rejects(
      resolveCurrentUser(makeContext({
        headers: {
          "x-workspace-user-email": "ada@example.com",
          "x-workspace-provider-subject-id": "oid-1"
        }
      })),
      { status: 503, message: "auth_worker_url_not_configured" }
    );
  });

  it("ignores forwarded identity headers when no Auth Worker session is present", async () => {
    await assert.rejects(
      resolveCurrentUser(makeContext({
        env: { AUTH_WORKER_URL: "https://auth.example.test" },
        headers: {
          "x-workspace-user-email": "ada@example.com",
          "x-workspace-provider-subject-id": "oid-1"
        }
      })),
      { status: 401, message: "not_authenticated" }
    );
  });

  it("maps an Auth Worker session into a Portal current user without DB sync", async () => {
    const currentUser = await withAuthWorkerSession(async () => resolveCurrentUser(makeContext({
      env: {
        AUTH_WORKER_URL: "https://auth.example.test",
        DEFAULT_TEAM_NAME: "Platform"
      },
      headers: { cookie: "workspace_session=session-1" }
    })));

    assert.equal(currentUser.id, "user-1");
    assert.equal(currentUser.email, "ada@example.com");
    assert.equal(currentUser.team, "");
    assert.equal(currentUser.role, "admin");
    assert.deepEqual(currentUser.identity, {
      authenticationMethod: "microsoft_entra_id",
      provider: "dingtalk",
      tenantId: "tenant-1",
      objectId: "ding-user-1",
      principalName: "ada@example.com"
    });
  });

  it("preserves the display-only Moka department path from Auth", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      authenticated: true,
      user: {
        id: "user-1",
        email: "ada@example.com",
        name: "Ada",
        role: "member",
        department: "AI Adoption",
        departmentId: "dept-ai",
        departmentPath: ["dept-root", "dept-group", "dept-ai"],
        departmentDisplayPath: "Group/AI Adoption"
      }
    }), { headers: { "content-type": "application/json" } });

    try {
      const user = await resolveCurrentUser(makeContext({
        env: { AUTH_WORKER_URL: "https://auth.example.test" },
        headers: { cookie: "workspace_session=session-1" }
      }));
      assert.equal(user.department, "AI Adoption");
      assert.equal(user.departmentDisplayPath, "Group/AI Adoption");
      assert.deepEqual(user.departmentPath, ["dept-root", "dept-group", "dept-ai"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("allows a pre-authorized active email OTP admin through the admin role boundary", async () => {
    const currentUser = await withAuthWorkerSession(
      async () => requireAdminPortalUser(makeContext({
        env: { AUTH_WORKER_URL: "https://auth.example.test" },
        headers: { cookie: "workspace_session=session-1" }
      })),
      "email_otp"
    );

    assert.equal(currentUser.role, "admin");
    assert.equal(currentUser.identity.authenticationMethod, "email_otp");
  });

  it("still rejects a pre-authorized non-admin email OTP user at the admin role boundary", async () => {
    await assert.rejects(
      withAuthWorkerSession(
        async () => requireAdminPortalUser(makeContext({
          env: { AUTH_WORKER_URL: "https://auth.example.test" },
          headers: { cookie: "workspace_session=session-1" }
        })),
        "email_otp",
        "member"
      ),
      { status: 403, message: "admin_required" }
    );
  });

  it("preserves the Portal DB admin role for pre-authorized OTP and Entra login", async () => {
    const db = createPortalAdminReadDb();
    const fallbackUser = {
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
      team: "Platform",
      role: "member",
      identity: {
        authenticationMethod: "email_otp",
        provider: "microsoft_entra_id",
        tenantId: "tenant-1",
        objectId: "entra-user-1",
        principalName: "ada@example.com"
      }
    };

    const otpUser = await readPortalCurrentUser(db, "user-1", fallbackUser);
    const entraUser = await readPortalCurrentUser(db, "user-1", {
      ...fallbackUser,
      identity: { ...fallbackUser.identity, authenticationMethod: "microsoft_entra_id" }
    });

    assert.equal(otpUser.role, "admin");
    assert.equal(entraUser.role, "admin");
  });

  it("creates and logs in a new Portal user when LiteLLM is not configured", async () => {
    const originalFetch = globalThis.fetch;
    const events = [];
    const db = createNewPortalUserDb(events);

    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      if (requestUrl === "https://auth.example.test/auth/session") {
        return authSessionResponse();
      }
      throw new Error(`unexpected identity request: ${requestUrl}`);
    };

    try {
      const currentUser = await resolveCurrentUser(makeContext({
        env: {
          AUTH_WORKER_URL: "https://auth.example.test",
          DB: db,
          DEFAULT_TEAM_ID: "team-ai-adoption",
          DEFAULT_TEAM_NAME: "AI Adoption"
        },
        headers: { cookie: "workspace_session=session-1" }
      }));

      assert.equal(currentUser.id, "user-1");
      assert.equal(currentUser.email, "ada@example.com");
      assert.equal(currentUser.identity.objectId, "ding-user-1");
      assert.deepEqual(events, ["portal-insert", "identity-upsert"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not contact an unavailable configured LiteLLM URL while creating a Portal user", async () => {
    const originalFetch = globalThis.fetch;
    const events = [];
    const db = createNewPortalUserDb(events);
    let liteLlmRequests = 0;

    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      if (requestUrl === "https://auth.example.test/auth/session") {
        return authSessionResponse();
      }
      if (requestUrl.startsWith("https://unavailable-token.example.test/")) {
        liteLlmRequests += 1;
        throw new Error("LiteLLM unavailable");
      }
      throw new Error(`unexpected identity request: ${requestUrl}`);
    };

    try {
      const currentUser = await resolveCurrentUser(makeContext({
        env: {
          AUTH_WORKER_URL: "https://auth.example.test",
          DB: db,
          DEFAULT_TEAM_ID: "team-ai-adoption",
          DEFAULT_TEAM_NAME: "AI Adoption",
          LITELLM_PROVISIONING_KEY: "sk-provisioning",
          LITELLM_URL: "https://unavailable-token.example.test"
        },
        headers: { cookie: "workspace_session=session-1" }
      }));

      assert.equal(currentUser.id, "user-1");
      assert.equal(liteLlmRequests, 0);
      assert.deepEqual(events, ["portal-insert", "identity-upsert"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prefers the session cookie when a business bearer token is also present", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://auth.example.test/auth/session");
      assert.equal(init.headers.get("cookie"), "workspace_session=session-1");
      assert.equal(init.headers.get("authorization"), null);

      return new Response(JSON.stringify({
        authenticated: true,
        user: {
          id: "user-1",
          name: "Ada",
          email: "ada@example.com",
          role: "admin",
          identity: {
            provider: "dingtalk",
            tenantId: "tenant-1",
            objectId: "ding-user-1",
            principalName: "ada@example.com"
          }
        }
      }), {
        headers: { "content-type": "application/json" }
      });
    };

    try {
      const currentUser = await resolveCurrentUser(makeContext({
        env: { AUTH_WORKER_URL: "https://auth.example.test" },
        headers: {
          authorization: "Bearer apps-business-token",
          cookie: "workspace_session=session-1"
        }
      }));

      assert.equal(currentUser.id, "user-1");
      assert.equal(currentUser.email, "ada@example.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces Auth Worker session failures as gateway errors", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => new Response("upstream down", { status: 500 });

    try {
      await assert.rejects(
        resolveCurrentUser(makeContext({
          env: { AUTH_WORKER_URL: "https://auth.example.test" },
          headers: { cookie: "workspace_session=session-1" }
        })),
        { status: 502, message: "auth_worker_session_failed" }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function withAuthWorkerSession(callback, authenticationMethod = "microsoft_entra_id", role = "admin") {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://auth.example.test/auth/session");
    assert.equal(init.headers.get("cookie"), "workspace_session=session-1");

    return new Response(JSON.stringify({
      authenticated: true,
      user: {
        id: "user-1",
        name: "Ada",
        email: "ada@example.com",
        role,
        identity: {
          ...(authenticationMethod ? { authenticationMethod } : {}),
          provider: "dingtalk",
          tenantId: "tenant-1",
          objectId: "ding-user-1",
          principalName: "ada@example.com"
        }
      }
    }), {
      headers: { "content-type": "application/json" }
    });
  };

  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function authSessionResponse() {
  return new Response(JSON.stringify({
    authenticated: true,
    user: {
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
      role: "admin",
      identity: {
        provider: "dingtalk",
        tenantId: "tenant-1",
        objectId: "ding-user-1",
        principalName: "ada@example.com"
      }
    }
  }), {
    headers: { "content-type": "application/json" }
  });
}

function createNewPortalUserDb(events) {
  return {
    prepare(sql) {
      const statement = {
        bindings: [],
        bind(...bindings) {
          statement.bindings = bindings;
          return statement;
        },
        async all() {
          if (sql.startsWith("PRAGMA table_info")) {
            return {
              results: ["avatar_url", "department_id", "department_path_json"].map((name) => ({ name }))
            };
          }
          return { results: [] };
        },
        async first() {
          if (sql.includes("FROM user_identity_profiles") && sql.includes("provider_subject_id")) {
            return null;
          }
          if (sql.includes("SELECT id AS userId FROM users")) {
            return null;
          }
          if (sql.includes("JOIN teams ON teams.id = users.team_id")) {
            return {
              id: "user-1",
              name: "Ada",
              email: "ada@example.com",
              avatarUrl: "",
              role: "member",
              status: "active",
              department: "",
              departmentId: "",
              departmentPathJson: "[]",
              jobTitle: "",
              profileJson: "{}",
              provider: "dingtalk",
              tenantId: "tenant-1",
              objectId: "ding-user-1",
              principalName: "ada@example.com",
              team: "AI Adoption"
            };
          }
          if (sql.includes("SELECT status FROM users")) {
            return { status: "active" };
          }
          return null;
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO users")) {
            events.push("portal-insert");
          }
          if (sql.includes("INSERT INTO user_identity_profiles")) {
            events.push("identity-upsert");
          }
          return { success: true };
        }
      };
      return statement;
    }
  };
}

function createPortalAdminReadDb() {
  return {
    prepare(sql) {
      const statement = {
        bind() {
          return statement;
        },
        async all() {
          return {
            results: ["avatar_url", "department_id", "department_path_json"].map((name) => ({ name }))
          };
        },
        async first() {
          assert.match(sql, /FROM users/);
          return {
            id: "user-1",
            name: "Ada",
            email: "ada@example.com",
            avatarUrl: "",
            role: "admin",
            status: "active",
            department: "Platform",
            departmentId: "department-1",
            departmentPathJson: "[\"department-1\"]",
            jobTitle: "",
            profileJson: "{}",
            provider: "microsoft_entra_id",
            tenantId: "tenant-1",
            objectId: "entra-user-1",
            principalName: "ada@example.com",
            team: "Platform"
          };
        }
      };
      return statement;
    }
  };
}
