import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuthBoundaryApi } from "./authBoundary/service.ts";
import { createLlmGatewayClient } from "./llmGateway/client.ts";
import { createPublicationAppsSourceReader } from "./publication/appsSource.ts";
import { createMcpPortalApi } from "./mcpPortal/service.ts";

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
  role: "admin",
  identity: {
    provider: "microsoft_entra_id",
    tenantId: "tenant-1",
    objectId: "oid-1",
    principalName: "ada@example.com"
  }
};

function requireText(value, errorCode, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new TestHttpError(400, errorCode);
  }
  return text.slice(0, maxLength);
}

function readBody(request) {
  return request.headers.get("content-type")?.includes("application/json")
    ? request.json()
    : {};
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers }
  });
}

function launchableAppDb() {
  const app = {
    accessMode: "request",
    accessTargetsJson: "[\"department:AI Adoption\"]",
    businessOwnerUserId: "owner-1",
    callbackUrl: "https://app.example.com/auth/workspace/callback",
    id: "app-1",
    launchUrl: "https://app.example.com",
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

describe("pages api worker contracts", () => {
  it("calls Auth Worker direct-jump with service auth and lets Auth resolve canonical policy", async () => {
    const fetchCalls = [];
    const api = createAuthBoundaryApi({
      async audit() {
        return "audit-1";
      },
      async fetch(url, init) {
        fetchCalls.push({ init, url });
        return jsonResponse({
          appId: "app-1",
          expiresAt: 123,
          token: "direct-token",
          tokenType: "Bearer"
        });
      },
      httpError(status, message) {
        return new TestHttpError(status, message);
      },
      readBody,
      requireDb(db) {
        if (!db) {
          throw new TestHttpError(503, "database_not_configured");
        }
        return db;
      },
      requireText,
      async resolveCurrentUser() {
        return currentUser;
      }
    });

    await api.createDirectJumpToken({
      env: {
        AUTH_SERVICE_TOKEN: "service-token",
        AUTH_WORKER_URL: "https://auth.example.test",
        DB: launchableAppDb()
      },
      request: new Request("https://portal.test/api/auth/direct-jump", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: "app-1", redirectUrl: "https://app.example.com/home" })
      })
    });

    assert.equal(fetchCalls[0].url, "https://auth.example.test/v1/app-login/direct-jump");
    assert.equal(fetchCalls[0].init.method, "POST");
    assert.equal(fetchCalls[0].init.headers.get("authorization"), "Bearer service-token");

    const body = JSON.parse(fetchCalls[0].init.body);
    assert.deepEqual(body, {
      appId: "app-1",
      redirectUrl: "https://app.example.com/home"
    });
    assert.equal(fetchCalls[0].init.headers.get("x-workspace-user-id"), "user-1");
  });

  it("calls LLM Gateway admin APIs with the gateway admin bearer token", async () => {
    let upstreamRequest;
    const client = createLlmGatewayClient({
      httpError(status, message) {
        return new TestHttpError(status, message);
      },
      async fetch(url, init) {
        upstreamRequest = { init, url };
        return jsonResponse({ ok: true });
      }
    });

    const payload = await client.adminJson({
      env: {
        LITELLM_PROVISIONING_KEY: "gateway-admin-token",
        LITELLM_URL: "https://token.example.test"
      },
      request: new Request("https://portal.test/api/llm-gateway/admin/allocations")
    }, "/admin/allocations/policies", {
      body: { targetType: "user", targetId: "user-1" },
      method: "POST"
    });

    assert.deepEqual(payload, { ok: true });
    assert.equal(upstreamRequest.url, "https://token.example.test/admin/allocations/policies");
    assert.equal(upstreamRequest.init.method, "POST");
    assert.equal(upstreamRequest.init.headers.Authorization, "Bearer gateway-admin-token");
    assert.equal(upstreamRequest.init.headers.Accept, "application/json");
    assert.equal(upstreamRequest.init.headers["Content-Type"], "application/json");
    assert.equal(upstreamRequest.init.body, JSON.stringify({ targetType: "user", targetId: "user-1" }));
  });

  it("calls APPS Worker source reads with read-only portal-issued APPS credentials", async () => {
    const upstreamCalls = [];
    const signedPayloads = [];
    const readSource = createPublicationAppsSourceReader({
      getTtlSeconds() {
        return 1800;
      },
      httpError(status, message) {
        return new TestHttpError(status, message);
      },
      appsOrgContext() {
        return { orgId: "org-1", orgSlug: "org-one" };
      },
      appsReadScopes: ["apps:apps:read", "apps:skills:read"],
      appsWorkerBaseUrl() {
        return "https://apps.example.test";
      },
      parseJson(value) {
        return JSON.parse(value);
      },
      async signAppsToken(_env, payload) {
        signedPayloads.push(payload);
        return "signed-apps-token";
      },
      async fetch(url, init) {
        upstreamCalls.push({ init, url });
        return jsonResponse({
          app: {
            id: "app-1",
            ownerUserId: "user-1",
            manifest: { runtime: "worker" },
            name: "Example App",
            status: "draft",
            updatedAt: "2026-06-30T00:00:00.000Z",
            visibility: "team"
          }
        });
      }
    });

    const source = await readSource({
      env: { PORTAL_ISSUER: "portal-contract" },
      request: new Request("https://portal.test/api/market/submissions")
    }, currentUser, "app", "app-1");

    assert.equal(upstreamCalls[0].url, "https://apps.example.test/apps/app-1");
    assert.equal(upstreamCalls[0].init.headers.Authorization, "Bearer signed-apps-token");
    assert.equal(upstreamCalls[0].init.headers["x-workspace-user-id"], "ada@example.com");
    assert.equal(upstreamCalls[0].init.headers["x-workspace-org-id"], "org-1");
    assert.equal(upstreamCalls[0].init.headers["x-workspace-scopes"], "apps:apps:read,apps:skills:read");
    assert.equal(signedPayloads[0].typ, "apps_access");
    assert.equal(signedPayloads[0].iss, "portal-contract");
    assert.equal(signedPayloads[0].org_id, "org-1");
    assert.deepEqual(signedPayloads[0].scopes, ["apps:apps:read", "apps:skills:read"]);
    assert.equal(source.verification.source, "apps-worker");
    assert.equal(source.builderSnapshot.app.id, "app-1");
  });

  it("maps Auth Worker direct-jump failures to a stable portal contract error", async () => {
    const api = createAuthBoundaryApi({
      async audit() {
        throw new Error("audit_should_not_run");
      },
      async fetch() {
        return new Response("auth unavailable", { status: 503 });
      },
      httpError(status, message) {
        return new TestHttpError(status, message);
      },
      readBody,
      requireDb(db) {
        if (!db) {
          throw new TestHttpError(503, "database_not_configured");
        }
        return db;
      },
      requireText,
      async resolveCurrentUser() {
        return currentUser;
      }
    });

    await assert.rejects(
      () => api.createDirectJumpToken({
        env: {
          AUTH_SERVICE_TOKEN: "service-token",
          AUTH_WORKER_URL: "https://auth.example.test",
          DB: launchableAppDb()
        },
        request: new Request("https://portal.test/api/auth/direct-jump", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appId: "app-1", redirectUrl: "https://app.example.com/home" })
        })
      }),
      (error) => error.status === 503 && error.message === "auth_worker_direct_jump_failed:auth unavailable"
    );
  });

  it("maps LLM Gateway admin failures to a stable portal contract error", async () => {
    const client = createLlmGatewayClient({
      httpError(status, message) {
        return new TestHttpError(status, message);
      },
      async fetch() {
        return new Response("bad gateway token", { status: 401 });
      }
    });

    await assert.rejects(
      () => client.adminJson({
        env: {
          LITELLM_PROVISIONING_KEY: "gateway-admin-token",
          LITELLM_URL: "https://token.example.test"
        },
        request: new Request("https://portal.test/api/llm-gateway/admin/allocations")
      }, "/admin/allocations/policies", {
        body: { targetType: "user", targetId: "user-1" },
        method: "POST"
      }),
      (error) => error.status === 502 && error.message === "llm_gateway_admin_request_failed:401"
    );
  });

  it("maps APPS Worker source failures to a stable portal contract error", async () => {
    const readSource = createPublicationAppsSourceReader({
      getTtlSeconds() {
        return 1800;
      },
      httpError(status, message) {
        return new TestHttpError(status, message);
      },
      appsOrgContext() {
        return { orgId: "org-1", orgSlug: "org-one" };
      },
      appsReadScopes: ["apps:apps:read", "apps:skills:read"],
      appsWorkerBaseUrl() {
        return "https://apps.example.test";
      },
      parseJson(value) {
        return JSON.parse(value);
      },
      async signAppsToken() {
        return "signed-apps-token";
      },
      async fetch() {
        return new Response("missing app", { status: 404 });
      }
    });

    await assert.rejects(
      () => readSource({
        env: { PORTAL_ISSUER: "portal-contract" },
        request: new Request("https://portal.test/api/market/submissions")
      }, currentUser, "app", "missing-app"),
      (error) => error.status === 404 && error.message === "apps_worker_validation_failed:404:missing app"
    );
  });
});
