import assert from "node:assert/strict";
import { it } from "node:test";
import { onRequest } from "./access.ts";

it("renders a verified bilingual Portal access page without exposing internal policy reasons", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const endpoint = new URL(String(url));
    assert.equal(endpoint.origin, "https://auth.example.test");
    assert.equal(endpoint.pathname, "/auth/access/result");
    assert.equal(endpoint.searchParams.get("result"), "signed-access-result");
    return Response.json({
      app: { id: "app-1", name: "Private Banking Assistant" },
      code: "ACCESS_NOT_GRANTED",
      launchUrl: "https://app.example.test/",
      requestId: "request-123",
      valid: true
    });
  };

  try {
    const response = await onRequest({
      env: { AUTH_WORKER_URL: "https://auth.example.test" },
      request: new Request("https://ai.example.invalid/auth/access?result=signed-access-result")
    });
    const html = await response.text();
    assert.equal(response.status, 403);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(html, /你没有足够权限访问此 App/);
    assert.match(html, /Please contact the app author to request access/);
    assert.match(html, /Private Banking Assistant/);
    assert.match(html, /request-123/);
    assert.doesNotMatch(html, /denied_not_targeted/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("fails closed with an expired-session page when the signed result is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "token_expired" }, { status: 401 });
  try {
    const response = await onRequest({
      env: { AUTH_WORKER_URL: "https://auth.example.test" },
      request: new Request("https://ai.example.invalid/auth/access?result=expired")
    });
    const html = await response.text();
    assert.equal(response.status, 400);
    assert.match(html, /登录已过期/);
    assert.doesNotMatch(html, /token_expired/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
