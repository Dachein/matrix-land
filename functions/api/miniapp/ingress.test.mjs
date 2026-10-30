import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { onRequest } from "./[[path]].ts";

describe("miniapp Pages ingress", () => {
  it("fails closed when the dedicated Worker origin is not configured", async () => {
    const response = await onRequest({
      env: {},
      request: new Request("https://ai.example.invalid/api/miniapp/v1/auth/session")
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "miniapp_api_worker_not_configured" });
  });

  it("rejects paths outside the owned namespace before proxying", async () => {
    const response = await onRequest({
      env: { MINIAPP_API_WORKER_URL: "https://miniapp-api.example.invalid" },
      request: new Request("https://ai.example.invalid/api/miniapp/not-v1")
    });

    assert.equal(response.status, 404);
  });
});
