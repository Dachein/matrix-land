import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAppsProxyApi, appsProxyTimeoutMs, recordAppsAppPublishedActivity } from "./proxy.ts";

const currentUser = {
  id: "user-1",
  name: "Ada",
  email: "ada@example.com",
  team: "AI Adoption",
  departmentId: "wealth-hk",
  departmentPath: ["wealth", "wealth/wealth-hk"],
  identity: {
    provider: "microsoft_entra_id",
    objectId: "oid-1",
    tenantId: "tid-1"
  }
};

describe("apps proxy request handler", () => {
  it("gives Mate provisioning enough time without lengthening routine requests", () => {
    assert.equal(appsProxyTimeoutMs({}, "POST", "/mates/default"), 60_000);
    assert.equal(appsProxyTimeoutMs({}, "POST", "/mates"), 60_000);
    assert.equal(appsProxyTimeoutMs({}, "POST", "/mates/mate-1/deploy"), 60_000);
    assert.equal(appsProxyTimeoutMs({}, "POST", "/mates/mate-1/releases/mate-1-r1/publish"), 60_000);
    assert.equal(appsProxyTimeoutMs({}, "GET", "/mates/default"), 12_000);
    assert.equal(appsProxyTimeoutMs({ APPS_PROXY_TIMEOUT_MS: "60000" }, "POST", "/mates/default"), 60_000);
    assert.equal(appsProxyTimeoutMs({ APPS_PROXY_TIMEOUT_MS: "999999" }, "POST", "/mates/default"), 90_000);
  });

  it("forwards GET requests with portal-issued APPS credentials", async () => {
    let signedPayload;
    let upstreamRequest;
    const api = createAppsProxyApi({
      async currentUserTeamId() {
        return "team-1";
      },
      getTtlSeconds() {
        return 1200;
      },
      async resolveCurrentUser() {
        return currentUser;
      },
      async signAppsToken(_env, payload) {
        signedPayload = payload;
        return "signed-token";
      }
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
      upstreamRequest = { url, init };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "upstream-req-1"
        }
      });
    };

    try {
      const response = await api.proxyAppsWorkerRequest({
        request: new Request("https://portal.test/api/apps/inventory", {
          headers: {
            accept: "application/json",
            "x-request-id": "req-1"
          }
        }),
        env: {
          APPS_WORKER_URL: "https://apps.example.com",
          PORTAL_ISSUER: "portal"
        }
      }, "apps/inventory");

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-request-id"), "upstream-req-1");
      assert.equal(upstreamRequest.url, "https://apps.example.com/inventory");
      assert.equal(upstreamRequest.init.method, "GET");
      assert.equal(upstreamRequest.init.body, undefined);
      assert.equal(upstreamRequest.init.headers.get("Authorization"), "Bearer signed-token");
      assert.equal(upstreamRequest.init.headers.get("Accept"), "application/json");
      assert.equal(upstreamRequest.init.headers.get("x-request-id"), "req-1");
      assert.equal(upstreamRequest.init.headers.get("x-workspace-user-id"), "ada@example.com");
      assert.equal(upstreamRequest.init.headers.get("x-workspace-org-id"), "ai-adoption");
      assert.equal(upstreamRequest.init.headers.get("x-workspace-org-slug"), "ai-adoption");
      assert.equal(upstreamRequest.init.headers.get("x-workspace-scopes"), "apps:apps:read,apps:skills:read,apps:mates:read");
      assert.equal(signedPayload.iss, "portal");
      assert.equal(signedPayload.sub, "user-1");
      assert.equal(signedPayload.org_id, "ai-adoption");
      assert.equal(signedPayload.org_slug, "ai-adoption");
      assert.equal(signedPayload.department_id, "wealth-hk");
      assert.equal(signedPayload.name, "Ada");
      assert.deepEqual(signedPayload.department_path, ["wealth", "wealth/wealth-hk"]);
      assert.deepEqual(signedPayload.scopes, ["apps:apps:read", "apps:skills:read", "apps:mates:read"]);
      assert.equal(await response.json().then((body) => body.ok), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a bounded timeout response when the APPS Worker does not answer", async () => {
    const api = createAppsProxyApi({
      async currentUserTeamId() {
        return "team-1";
      },
      getTtlSeconds() {
        return 1200;
      },
      async resolveCurrentUser() {
        return currentUser;
      },
      async signAppsToken() {
        return "signed-token";
      }
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

    try {
      const response = await api.proxyAppsWorkerRequest({
        request: new Request("https://portal.test/api/apps/apps", {
          headers: { "x-request-id": "req-timeout-1" }
        }),
        env: {
          APPS_PROXY_TIMEOUT_MS: "20",
          APPS_WORKER_URL: "https://apps.example.com"
        }
      }, "apps/apps");

      assert.equal(response.status, 504);
      assert.equal(response.headers.get("x-request-id"), "req-timeout-1");
      assert.deepEqual(await response.json(), {
        error: "apps_worker_timeout",
        requestId: "req-timeout-1"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("streams source archives and preserves download integrity headers", async () => {
    const api = createAppsProxyApi({
      async currentUserTeamId() {
        return "team-1";
      },
      getTtlSeconds() {
        return 1200;
      },
      async resolveCurrentUser() {
        return currentUser;
      },
      async signAppsToken() {
        return "signed-token";
      }
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array([80, 75, 3, 4]), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": "attachment; filename=\"source.zip\"",
        "content-length": "4",
        "content-type": "application/zip",
        "x-workspace-source-archive-sha256": "archive-hash",
        "x-workspace-source-content-sha256": "content-hash"
      }
    });

    try {
      const response = await api.proxyAppsWorkerRequest({
        request: new Request("https://portal.test/api/apps/apps/app-1/source-snapshots/snap-1/download", {
          headers: { accept: "application/zip" }
        }),
        env: { APPS_WORKER_URL: "https://apps.example.com" }
      }, "apps/apps/app-1/source-snapshots/snap-1/download");

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-disposition"), "attachment; filename=\"source.zip\"");
      assert.equal(response.headers.get("content-length"), "4");
      assert.equal(response.headers.get("x-workspace-source-archive-sha256"), "archive-hash");
      assert.equal(response.headers.get("x-workspace-source-content-sha256"), "content-hash");
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [80, 75, 3, 4]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a stable unavailable response for upstream network failures", async () => {
    const api = createAppsProxyApi({
      async currentUserTeamId() {
        return "team-1";
      },
      getTtlSeconds() {
        return 1200;
      },
      async resolveCurrentUser() {
        return currentUser;
      },
      async signAppsToken() {
        return "signed-token";
      }
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("private upstream detail");
    };

    try {
      const response = await api.proxyAppsWorkerRequest({
        request: new Request("https://portal.test/api/apps/apps", {
          headers: { "x-request-id": "req-network-1" }
        }),
        env: { APPS_WORKER_URL: "https://apps.example.com" }
      }, "apps/apps");

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: "apps_worker_unavailable",
        requestId: "req-network-1"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records publish activity from successful upstream publish responses", async () => {
    const state = {};
    const db = {
      prepare(sql) {
        state.sql = sql;
        return {
          bind(...bindings) {
            state.bindings = bindings;
            return {
              async run() {
                state.ran = true;
              }
            };
          }
        };
      }
    };
    const payload = {
      app: {
        name: "Demo App",
        lastDeployedAt: "v1",
        visibility: "public",
        productionUrl: "https://demo.example.com"
      }
    };

    await recordAppsAppPublishedActivity(
      db,
      {},
      currentUser,
      "app-1",
      new TextEncoder().encode(JSON.stringify(payload)).buffer,
      "application/json",
      "req-1",
      {
        async currentUserTeamId() {
          return "team-1";
        }
      }
    );

    assert.equal(state.ran, true);
    assert.match(state.sql, /INSERT OR IGNORE INTO activity_events/);
    assert.equal(state.bindings[1], "apps");
    assert.equal(state.bindings[2], "apps.app.published");
    assert.equal(state.bindings[7], "apps_app");
    assert.equal(state.bindings[8], "app-1");
    assert.equal(state.bindings[9], "Demo App");
    assert.equal(state.bindings[15], "org");
    assert.equal(state.bindings[16], "team-1");
    assert.deepEqual(JSON.parse(state.bindings[17]), {
      appId: "app-1",
      version: "v1",
      visibility: "public",
      productionUrl: "https://demo.example.com"
    });
    assert.equal(state.bindings[19], "apps.app.published:app-1:v1");
  });
});

describe('ownership admin proxy', () => {
  for (const role of ['member', 'admin']) {
    it(`${role}: enforces the server-resolved role before signing an administrative request`, async () => {
      let signed;
      const api = createAppsProxyApi({ currentUserTeamId: async () => 'team', getTtlSeconds: () => 900, resolveCurrentUser: async () => ({ ...currentUser, role }), signAppsToken: async (_env, payload) => { signed = payload; return 'signed'; } });
      const original = globalThis.fetch;
      globalThis.fetch = async () => Response.json({ assets: [] });
      try {
        const response = await api.proxyAppsWorkerRequest({ request: new Request('https://portal.test/api/apps/admin/ownership', { headers: { 'x-platform-role': 'admin' } }), env: { APPS_WORKER_URL: 'https://apps.test', APPS_ORG_ID: 'org' } }, 'apps/admin/ownership');
        assert.equal(response.status, role === 'admin' ? 200 : 403);
        if (role === 'admin') { assert.equal(signed.platform_role, 'admin'); assert.deepEqual(signed.scopes, ['apps:ownership:admin']); } else assert.equal(signed, undefined);
      } finally { globalThis.fetch = original; }
    });
  }
});
