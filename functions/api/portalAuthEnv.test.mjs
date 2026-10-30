import assert from "node:assert/strict";
import { it } from "node:test";
import { envWithPortalAuthToken } from "./[[route]].ts";

it("projects the dedicated Portal credential onto legacy API service consumers", () => {
  const source = {
    AUTH_SERVICE_TOKEN: "legacy-token",
    PORTAL_AUTH_SERVICE_TOKEN: "portal-token"
  };
  const env = envWithPortalAuthToken(source);

  assert.equal(env.AUTH_SERVICE_TOKEN, "portal-token");
  assert.equal(env.PORTAL_AUTH_SERVICE_TOKEN, "portal-token");
  assert.equal(source.AUTH_SERVICE_TOKEN, "legacy-token");
});

it("keeps the legacy API service credential as a migration fallback", () => {
  const source = { AUTH_SERVICE_TOKEN: "legacy-token" };
  assert.equal(envWithPortalAuthToken(source), source);
});
