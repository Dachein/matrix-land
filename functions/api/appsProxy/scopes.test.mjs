import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APPS_INVENTORY_READ_SCOPES, APPS_READ_SCOPES, appsScopesForProxyRequest, sanitizeAppsScopes } from "./scopes.ts";

describe("apps proxy scopes", () => {
  it("uses read scopes for GET and HEAD", () => {
    assert.deepEqual(appsScopesForProxyRequest("GET", "/apps"), APPS_READ_SCOPES);
    assert.deepEqual(appsScopesForProxyRequest("GET", "/inventory"), APPS_INVENTORY_READ_SCOPES);
    assert.deepEqual(appsScopesForProxyRequest("HEAD", "/inventory"), APPS_INVENTORY_READ_SCOPES);
    assert.deepEqual(appsScopesForProxyRequest("HEAD", "/skills/skill_1"), APPS_READ_SCOPES);
    assert.deepEqual(appsScopesForProxyRequest("GET", "/mates"), ["apps:mates:read"]);
  });

  it("maps write routes to the narrowest needed scopes", () => {
    assert.deepEqual(appsScopesForProxyRequest("POST", "/apps/app_1/secrets/value"), ["apps:secrets:write", "apps:apps:read"]);
    assert.deepEqual(appsScopesForProxyRequest("POST", "/apps/app_1/handoff-link"), ["apps:apps:read"]);
    assert.deepEqual(appsScopesForProxyRequest("POST", "/skills"), ["apps:skills:write", "apps:skills:admin", "apps:skills:read"]);
    assert.deepEqual(appsScopesForProxyRequest("PATCH", "/skills/skill_1"), ["apps:skills:write", "apps:skills:admin", "apps:skills:read"]);
    assert.deepEqual(appsScopesForProxyRequest("PATCH", "/skills/skill_1/visibility"), ["apps:skills:write", "apps:skills:admin", "apps:skills:read"]);
    assert.deepEqual(appsScopesForProxyRequest("POST", "/mates"), ["apps:mates:write", "apps:mates:admin", "apps:mates:read"]);
    assert.deepEqual(appsScopesForProxyRequest("POST", "/apps/app_1/publish"), ["apps:deploy:production", "apps:apps:admin", "apps:apps:read"]);
  });

  it("sanitizes requested scopes and falls back when none are allowed", () => {
    assert.deepEqual(sanitizeAppsScopes(["apps:apps:read", "bad", "apps:apps:read"], APPS_READ_SCOPES), ["apps:apps:read"]);
    assert.deepEqual(sanitizeAppsScopes(["bad"], APPS_READ_SCOPES), APPS_READ_SCOPES);
    assert.deepEqual(sanitizeAppsScopes("apps:apps:read", APPS_READ_SCOPES), APPS_READ_SCOPES);
  });
});

describe('ownership administration scope', () => {
    it('uses a dedicated scope that cannot be requested by token clients', () => {
      assert.deepEqual(appsScopesForProxyRequest('POST', '/admin/ownership/apps/app_1'), ['apps:ownership:admin']);
      assert.deepEqual(sanitizeAppsScopes(['apps:ownership:admin'], APPS_READ_SCOPES), APPS_READ_SCOPES);
    });
});
