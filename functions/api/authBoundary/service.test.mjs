import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuthBoundaryApi } from "./service.ts";

class TestHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const currentUser = {
  id: "user-1",
  name: "Ada",
  email: "ada@example.com",
  team: "AI Adoption",
  role: "member",
  identity: {
    provider: "microsoft_entra_id",
    tenantId: "tenant-1",
    objectId: "user-1",
    principalName: "ada@example.com"
  }
};

function createApi(overrides = {}) {
  const auditEvents = [];
  const api = createAuthBoundaryApi({
    async audit(_db, actorType, actorId, action, targetType, targetId, metadata) {
      auditEvents.push({ actorType, actorId, action, targetType, targetId, metadata });
      return "audit-1";
    },
    async fetch(url, init) {
      overrides.fetchCalls?.push({ init, url });
      return new Response(JSON.stringify(overrides.fetchResponse ?? { id: "ok" }), {
        status: overrides.fetchStatus ?? 200
      });
    },
    httpError(status, message) {
      return new TestHttpError(status, message);
    },
    async readBody(request) {
      return request.headers.get("content-type")?.includes("application/json")
        ? request.json()
        : {};
    },
    requireDb(db) {
      if (!db) {
        throw new TestHttpError(503, "database_not_configured");
      }
      return db;
    },
    requireText(value, errorCode, maxLength) {
      const text = String(value ?? "").trim();
      if (!text) {
        throw new TestHttpError(400, errorCode);
      }
      return text.slice(0, maxLength);
    },
    async resolveCurrentUser() {
      return overrides.currentUser ?? currentUser;
    }
  });

  return { api, auditEvents };
}

function jsonRequest(path, body) {
  return new Request(`https://portal.test/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function makeDb() {
  const app = {
    accessMode: "request",
    accessTargetsJson: "[\"department:AI Adoption\"]",
    businessOwnerUserId: "owner-1",
    callbackUrl: "https://app.example.com/auth/workspace/callback",
    id: "app-1",
    launchUrl: "https://app.example.com/home",
    name: "Example App",
    publisherUserId: "publisher-1",
    sdkStatus: "connected",
    status: "listed"
  };

  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("FROM apps")) {
                return app;
              }
              if (sql.includes("FROM grants")) {
                return { status: "approved" };
              }
              return null;
            },
            async run() {
              return {};
            }
          };
        }
      };
    }
  };
}

describe("auth boundary service", () => {
  it("creates direct jump through Auth Worker without sending mutable authorization snapshots", async () => {
    const fetchCalls = [];
    const { api, auditEvents } = createApi({
      fetchCalls,
      fetchResponse: {
        appId: "app-1",
        directJumpUrl: "https://app.example.com/auth/workspace/callback?workspace_token=t",
        expiresAt: 123,
        token: "t",
        tokenType: "Bearer"
      }
    });

    const result = await api.createDirectJumpToken({
      env: {
        AUTH_SERVICE_TOKEN: "service-token",
        AUTH_WORKER_URL: "https://auth.test",
        DB: makeDb()
      },
      request: jsonRequest("auth/direct-jump", { appId: "app-1", redirectUrl: "https://app.example.com/home" })
    });

    assert.equal(result.token, "t");
    assert.equal(fetchCalls[0].url, "https://auth.test/v1/app-login/direct-jump");
    assert.equal(fetchCalls[0].init.headers.get("authorization"), "Bearer service-token");

    const body = JSON.parse(fetchCalls[0].init.body);
    assert.deepEqual(body, {
      appId: "app-1",
      redirectUrl: "https://app.example.com/home"
    });
    assert.equal(fetchCalls[0].init.headers.get("x-workspace-user-id"), "user-1");
    assert.equal(auditEvents[0].metadata.authWorker, true);
  });

  it("rejects non-admin API key issuance for another subject", async () => {
    const { api } = createApi();

    await assert.rejects(
      () => api.issueApiKey({
        env: {},
        request: jsonRequest("api-keys", { subjectType: "app", subjectId: "app-1" })
      }),
      (error) => error.status === 403 && error.message === "admin_required"
    );
  });

  it("writes audit events to Auth Worker with the current user as actor", async () => {
    const fetchCalls = [];
    const { api } = createApi({
      fetchCalls,
      fetchResponse: { id: "auth-audit-1" }
    });

    const result = await api.writeAuditEvent({
      env: {
        AUTH_SERVICE_TOKEN: "service-token",
        AUTH_WORKER_URL: "https://auth.test"
      },
      request: jsonRequest("audit", {
        action: "opened_app",
        actorId: "spoofed-user",
        actorType: "app",
        targetId: "app-1",
        targetType: "app"
      })
    });

    assert.deepEqual(result, { id: "auth-audit-1" });
    const body = JSON.parse(fetchCalls[0].init.body);
    assert.equal(body.actorUserId, "user-1");
    assert.equal(body.clientAppId, "app-1");
    assert.equal(body.metadata.legacyActorId, "spoofed-user");
  });
});
