import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { onRequest } from "./[[path]].ts";

describe("Portal Live Pages proxy", () => {
  it("forwards the Portal session cookie to the Live origin", async () => {
    const originalFetch = globalThis.fetch;
    let forwarded;
    globalThis.fetch = async (request) => {
      forwarded = request;
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    };

    try {
      const response = await onRequest({
        env: {LIVE_WORKER_URL:"https://live.example.invalid"},
        params: { path: ["v1", "snapshot"] },
        request: new Request("https://ai.example.invalid/live/v1/snapshot?workspaceId=workspace-ai-playground", {
          headers: {
            cookie: "workspace_session=session-token",
            origin: "https://ai.example.invalid"
          }
        })
      });

      assert.equal(response.status, 200);
      assert.equal(forwarded.url, "https://live.example.invalid/v1/snapshot?workspaceId=workspace-ai-playground");
      assert.equal(forwarded.headers.get("cookie"), "workspace_session=session-token");
      assert.equal(forwarded.headers.get("origin"), "https://ai.example.invalid");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not expose the Live event publisher", async () => {
    const response = await onRequest({
      params: { path: ["v1", "events"] },
      request: new Request("https://ai.example.invalid/live/v1/events", { method: "POST" })
    });
    assert.equal(response.status, 404);
  });

  it("returns the upstream WebSocket upgrade response without wrapping it", async () => {
    const originalFetch = globalThis.fetch;
    const upgradeResponse = { status: 101, webSocket: {} };
    let forwarded;
    globalThis.fetch = async (request) => {
      forwarded = request;
      return upgradeResponse;
    };

    try {
      const response = await onRequest({
        env: { LIVE_WORKER_URL: "https://live.example.test" },
        params: { path: ["v1", "live"] },
        request: new Request("https://ai.example.invalid/live/v1/live?workspaceId=workspace-ai-playground", {
          headers: {
            cookie: "workspace_session=session-token",
            upgrade: "websocket"
          }
        })
      });

      assert.equal(response, upgradeResponse);
      assert.equal(forwarded.url, "https://live.example.test/v1/live?workspaceId=workspace-ai-playground");
      assert.equal(forwarded.headers.get("upgrade"), "websocket");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
