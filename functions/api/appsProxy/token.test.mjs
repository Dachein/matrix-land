import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAppsTokenApi } from "./token.ts";

const currentUser = {
  id: "user-1",
  email: "builder@example.com",
  team: "AI Adoption",
  departmentId: "wealth-hk",
  departmentPath: ["wealth", "wealth/wealth-hk"],
  identity: {
    objectId: "oid-1",
    provider: "entra",
    tenantId: "tid-1"
  }
};

describe("apps token api", () => {
  it("issues short-lived apps access tokens", async () => {
    const auditCalls = [];
    let signedPayload;
    const api = createAppsTokenApi({
      async audit(...args) {
        auditCalls.push(args);
        return "audit-1";
      },
      getTtlSeconds() {
        return 3600;
      },
      async readBody(request) {
        return request.json();
      },
      async resolveCurrentUser() {
        return currentUser;
      },
      async signAppsToken(_env, payload) {
        signedPayload = payload;
        return "signed-token";
      }
    });

    const issuedBefore = Math.floor(Date.now() / 1000);
    const result = await api.issueAppsToken({
      env: {
        DB: "db"
      },
      request: new Request("https://portal.test/api/apps/token", {
        body: JSON.stringify({ appId: "app-1", scopes: ["apps:apps:read", "bad"] }),
        method: "POST"
      })
    });
    const issuedAfter = Math.floor(Date.now() / 1000);

    assert.equal(result.token, "signed-token");
    assert.equal(result.tokenType, "Bearer");
    assert.deepEqual(result.scopes, ["apps:apps:read"]);
    assert.equal(signedPayload.typ, "apps_access");
    assert.equal(signedPayload.app_id, "app-1");
    assert.equal(signedPayload.sub, "user-1");
    assert.equal(signedPayload.department_id, "wealth-hk");
    assert.deepEqual(signedPayload.department_path, ["wealth", "wealth/wealth-hk"]);
    assert.deepEqual(signedPayload.scopes, ["apps:apps:read"]);
    assert.ok(result.expiresAt >= issuedBefore + 900);
    assert.ok(result.expiresAt <= issuedAfter + 900);
    assert.deepEqual(auditCalls[0].slice(1, 6), ["user", "user-1", "issued apps token", "apps", "app-1"]);
  });
});
