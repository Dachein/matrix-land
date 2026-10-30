import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpPortalApi } from "./service.ts";

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
  const fetchCalls = [];
  const api = createMcpPortalApi({
    async fetch(url, init) {
      fetchCalls.push({ init, url });
      return new Response(JSON.stringify(overrides.fetchResponse ?? { ok: true }), {
        status: overrides.fetchStatus ?? 200
      });
    },
    httpError(status, message) {
      return new TestHttpError(status, message);
    },
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        ...init,
        headers: { "content-type": "application/json", ...init.headers }
      });
    },
    parseJson(value) {
      return JSON.parse(value);
    },
    async readBody(request) {
      return request.headers.get("content-type")?.includes("application/json")
        ? request.json()
        : {};
    },
    async requireAdminPortalUser() {
      return { ...currentUser, role: "admin" };
    },
    requireSecret(value, name) {
      const normalized = value?.trim();
      if (!normalized) {
        throw new TestHttpError(503, `${name}_not_configured`);
      }
      return normalized;
    },
    requireText(value, errorCode, maxLength) {
      const text = String(value ?? "").trim();
      if (!text) {
        throw new TestHttpError(400, errorCode);
      }
      return text.slice(0, maxLength);
    },
    async resolveCurrentUser() {
      return currentUser;
    }
  });

  return { api, fetchCalls };
}

function context(path, body, env = {}) {
  return {
    env: {
      AUTH_WORKER_URL: "https://auth.test",
      AUTH_SERVICE_TOKEN: "service-token",
      MCP_APPROVAL_TOKEN: "approval-token",
      ...env
    },
    request: new Request(`https://portal.test/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    })
  };
}

describe("mcp portal service", () => {
  it("lists all-user MCP connections through the protected Auth admin endpoint", async () => {
    const { api, fetchCalls } = createApi({
      fetchResponse: {
        connections: [{ id: "conn-1", status: "active" }],
        summary: { activeCount: 1, inactiveCount: 0, totalCount: 1, userCount: 1 }
      }
    });

    const response = await api.readAdminConnections(context("admin/mcp/connections?status=all&q=Ada"));
    const payload = await response.json();

    assert.equal(payload.connections[0].id, "conn-1");
    assert.equal(fetchCalls[0].url, "https://auth.test/v1/admin/mcp/connections?status=all&limit=1000&q=Ada");
    assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer service-token");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("defaults the admin MCP connection list to active", async () => {
    const { api, fetchCalls } = createApi({ fetchResponse: { connections: [], summary: {} } });

    await api.readAdminConnections(context("admin/mcp/connections"));

    assert.equal(fetchCalls[0].url, "https://auth.test/v1/admin/mcp/connections?status=active&limit=1000");
  });

  it("reads the shared Auth login email policy for administrators", async () => {
    const { api, fetchCalls } = createApi({
      fetchResponse: { policy: { mode: "company_email_only", allowedDomains: ["example.com"] } }
    });

    const response = await api.readAdminLoginEmailPolicy(context("admin/login-email-policy"));

    assert.equal((await response.json()).policy.mode, "company_email_only");
    assert.equal(fetchCalls[0].url, "https://auth.test/v1/admin/login-email-policy");
    assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer service-token");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("updates the shared Auth login email policy as the current administrator", async () => {
    const { api, fetchCalls } = createApi({
      fetchResponse: { policy: { mode: "open", allowedDomains: ["example.com"] } }
    });

    const response = await api.updateAdminLoginEmailPolicy(context("admin/login-email-policy", {
      allowedDomains: ["example.com"],
      mode: "open"
    }));

    assert.equal((await response.json()).policy.mode, "open");
    assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
      allowedDomains: ["example.com"],
      mode: "open",
      updatedByUserId: "user-1"
    });
  });

  it("disables an MCP connection as the current admin", async () => {
    const { api, fetchCalls } = createApi({ fetchResponse: { connection: { id: "conn/1", status: "inactive" } } });

    const response = await api.disableAdminConnection(context("admin/mcp/connections/conn%2F1/disable", {}), "conn%2F1");
    const payload = await response.json();

    assert.equal(payload.connection.status, "inactive");
    assert.equal(fetchCalls[0].url, "https://auth.test/v1/admin/mcp/connections/conn%2F1/disable");
    assert.equal(fetchCalls[0].init.method, "POST");
    assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer service-token");
    assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { actorUserId: "user-1" });
  });

  it("reads MCP connection status through Auth Worker", async () => {
    const { api, fetchCalls } = createApi({
      fetchResponse: {
        status: {
          activeCount: 1,
          connected: true,
          maxActiveConnections: 3,
          userId: "user-1"
        }
      }
    });

    const response = await api.readConnectionStatus(context("mcp/connections/status"));
    const payload = await response.json();

    assert.equal(payload.status.connected, true);
    assert.equal(fetchCalls[0].url, "https://auth.test/v1/mcp/connections/status");
    assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer approval-token");

    const body = JSON.parse(fetchCalls[0].init.body);
    assert.equal(body.user.id, "user-1");
  });

  it("revokes MCP connections through Auth Worker", async () => {
    const { api, fetchCalls } = createApi({ fetchResponse: { revoked: true } });

    const response = await api.revokeConnection(context("mcp/connections/conn-1"), "conn-1");
    const payload = await response.json();

    assert.equal(payload.revoked, true);
    assert.equal(fetchCalls[0].url, "https://auth.test/v1/mcp/connections/revoke");

    const body = JSON.parse(fetchCalls[0].init.body);
    assert.equal(body.connectionId, "conn-1");
    assert.equal(body.user.id, "user-1");
  });
});
