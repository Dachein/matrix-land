import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMiniappFacadeApi } from "./facade.ts";

class TestHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function api(fetch) {
  return createMiniappFacadeApi({
    fetch,
    httpError: (status, code) => new TestHttpError(status, code)
  });
}

describe("miniapp Worker facade", () => {
  it("preserves history pagination through the miniapp API", async () => {
    const response = await api(async (url) => {
      assert.equal(new URL(url).searchParams.get("cursor"), "m-49");
      return Response.json([], { headers: { "X-Workspace-Chat-Next-Cursor": "m-99" } });
    }).proxyRuntime({ env: { MATE_RUNTIME_URL: "https://runtime.test" }, request: new Request("https://miniapp.test/api/miniapp/v1/mates/t/conversations/c/chat/get-messages?cursor=m-49&grant=signed") }, "/v1/mates/t/conversations/c/chat/get-messages");
    assert.equal(response.headers.get("X-Workspace-Chat-Next-Cursor"), "m-99");
  });
  it("adds trusted OTP metadata and strips spoofed identity headers", async () => {
    let forwarded;
    const response = await api(async (url, init) => {
      forwarded = { init, url: String(url) };
      return new Response(JSON.stringify({ challengeId: "challenge-1" }), {
        headers: { "content-type": "application/json", "set-cookie": "session=s1; Path=/; HttpOnly" }
      });
    }).proxyAuth({
      env: {
        AUTH_WORKER_URL: "https://auth.internal.test",
        PORTAL_AUTH_SERVICE_TOKEN: "proxy-secret"
      },
      request: new Request("https://ai.example.invalid/api/miniapp/v1/auth/email/login", {
        body: JSON.stringify({ email: "ada@example.com" }),
        headers: {
          "cf-connecting-ip": "203.0.113.8",
          "content-type": "application/json",
          "x-workspace-miniapp-public-origin": "https://spoofed.example",
          "x-workspace-user-id": "spoofed"
        },
        method: "POST"
      })
    }, "/auth/email/login");

    assert.equal(forwarded.url, "https://auth.internal.test/auth/email/login");
    assert.equal(forwarded.init.headers.get("x-workspace-user-id"), null);
    assert.equal(forwarded.init.headers.get("x-workspace-miniapp-public-origin"), null);
    assert.equal(forwarded.init.headers.get("x-workspace-auth-proxy-token"), "proxy-secret");
    assert.equal(forwarded.init.headers.get("x-workspace-client-ip"), "203.0.113.8");
    assert.equal(forwarded.init.headers.get("x-workspace-auth-channel"), "miniapp");
    assert.match(response.headers.get("set-cookie"), /^session=s1/);
  });

  it("forwards only the Runtime bearer and transport headers", async () => {
    let forwarded;
    const response = await api(async (url, init) => {
      forwarded = { init, url: String(url) };
      return Response.json({ conversations: [] });
    }).proxyRuntime({
      env: { MATE_RUNTIME_URL: "https://runtime.internal.test" },
      request: new Request("https://ai.example.invalid/api/miniapp/v1/mates/mate-1/conversations?limit=20", {
        headers: { authorization: "Bearer runtime-token", cookie: "portal=session" }
      })
    }, "/v1/mates/mate-1/conversations");

    assert.equal(forwarded.url, "https://runtime.internal.test/v1/mates/mate-1/conversations?limit=20");
    assert.equal(forwarded.init.headers.get("authorization"), "Bearer runtime-token");
    assert.equal(forwarded.init.headers.get("cookie"), null);
    assert.deepEqual(await response.json(), { conversations: [] });
  });

  it("returns WebSocket upgrades without reconstructing the response", async () => {
    const upgrade = { status: 101, webSocket: { accepted: true } };
    const result = await api(async (_url, init) => {
      assert.equal(init.headers.get("upgrade"), "websocket");
      return upgrade;
    }).proxyRuntime({
      env: { MATE_RUNTIME_URL: "https://runtime.internal.test" },
      request: new Request("https://ai.example.invalid/api/miniapp/v1/mates/mate-1/conversations/conv-1/chat", {
        headers: { upgrade: "websocket" }
      })
    }, "/v1/mates/mate-1/conversations/conv-1/chat");

    assert.equal(result, upgrade);
  });
});
