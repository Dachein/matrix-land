import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appsOrgContext, appsWorkerBaseUrl } from "./context.ts";

describe("apps proxy context", () => {
  it("normalizes the APPS worker base URL", () => {
    assert.equal(appsWorkerBaseUrl({}), "http://127.0.0.1:8791");
    assert.equal(appsWorkerBaseUrl({ APPS_WORKER_URL: "https://apps.example.com///" }), "https://apps.example.com");
  });

  it("uses explicit org config before deriving from user team", () => {
    assert.deepEqual(
      appsOrgContext({ APPS_ORG_ID: "workspace", APPS_ORG_SLUG: "workspace-wealth" }, { team: "AI Adoption" }),
      { orgId: "workspace", orgSlug: "workspace-wealth" }
    );
  });

  it("derives org id and slug from the current user team", () => {
    assert.deepEqual(
      appsOrgContext({}, { team: "AI Adoption / Platform" }),
      { orgId: "ai-adoption-platform", orgSlug: "ai-adoption-platform" }
    );
  });
});
