import assert from "node:assert/strict";
import { it } from "node:test";
import { onRequest } from "./[[path]].ts";

it("strips forged identity and proxy headers before signing the OTP client IP", async () => {
  const originalFetch = globalThis.fetch;
  const body = {
    email: "ai-adoption@example.invalid",
    redirect: "/home"
  };

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://auth.example.test/auth/email/login");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.get("origin"), "https://ai.example.invalid");
    assert.equal(init.headers.get("x-workspace-public-origin"), "https://ai.example.invalid");
    assert.equal(init.headers.get("x-workspace-auth-proxy-token"), "trusted-pages-proxy-token");
    assert.equal(init.headers.get("x-workspace-client-ip"), "203.0.113.42");
    assert.equal(init.headers.get("x-workspace-user-id"), null);
    assert.equal(init.headers.get("x-workspace-user-email"), null);
    assert.equal(init.headers.get("x-workspace-provider-subject-id"), null);
    assert.equal(init.headers.get("x-workspace-entra-object-id"), null);
    assert.equal(init.headers.get("x-workspace-role"), null);
    assert.equal(init.headers.get("x-workspace-team-id"), null);
    assert.equal(init.headers.get("x-workspace-department-id"), null);
    assert.equal(init.headers.get("cf-access-authenticated-user-email"), null);
    assert.equal(init.headers.get("cf-access-jwt-assertion"), null);

    assert.deepEqual(await new Response(init.body).json(), body);
    return new Response(JSON.stringify({ accepted: true, challengeId: "challenge-1" }), {
      status: 202,
      headers: {
        "content-type": "application/json",
        "set-cookie": "workspace_email_otp_state=state-1; Path=/auth/email; HttpOnly; Secure; SameSite=Strict"
      }
    });
  };

  try {
    const response = await onRequest({
      env: {
        AUTH_SERVICE_TOKEN: "legacy-service-token",
        AUTH_WORKER_URL: "https://auth.example.test",
        PORTAL_AUTH_SERVICE_TOKEN: "trusted-pages-proxy-token"
      },
      params: { path: ["email", "login"] },
      request: new Request("https://ai.example.invalid/auth/email/login", {
        method: "POST",
        headers: {
          "cf-access-authenticated-user-email": "attacker@example.test",
          "cf-access-jwt-assertion": "forged-access-jwt",
          "cf-connecting-ip": "203.0.113.42",
          "content-type": "application/json",
          origin: "https://ai.example.invalid",
          "x-workspace-auth-proxy-token": "attacker-proxy-token",
          "x-workspace-client-ip": "198.51.100.99",
          "x-workspace-department-id": "dept-admin",
          "x-workspace-entra-object-id": "forged-entra-object",
          "x-workspace-provider-subject-id": "forged-provider-subject",
          "x-workspace-public-origin": "https://attacker.example",
          "x-workspace-role": "admin",
          "x-workspace-team-id": "team-admin",
          "x-workspace-user-email": "attacker@example.test",
          "x-workspace-user-id": "attacker"
        },
        body: JSON.stringify(body)
      })
    });

    assert.equal(response.status, 202);
    assert.equal((await response.json()).accepted, true);
    assert.match(response.headers.get("set-cookie"), /workspace_email_otp_state=state-1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("falls back to the legacy service token during Portal credential migration", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.get("x-workspace-auth-proxy-token"), "legacy-service-token");
    return new Response(JSON.stringify({ accepted: true, challengeId: "challenge-legacy" }), {
      status: 202,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const response = await onRequest({
      env: {
        AUTH_SERVICE_TOKEN: "legacy-service-token",
        AUTH_WORKER_URL: "https://auth.example.test"
      },
      params: { path: ["email", "login"] },
      request: new Request("https://ai.example.invalid/auth/email/login", {
        body: JSON.stringify({ email: "ai-adoption@example.invalid" }),
        headers: {
          "cf-connecting-ip": "203.0.113.42",
          "content-type": "application/json",
          origin: "https://ai.example.invalid"
        },
        method: "POST"
      })
    });

    assert.equal(response.status, 202);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("never forwards a client-supplied proxy token when the Pages secret is absent", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.get("x-workspace-auth-proxy-token"), null);
    assert.equal(init.headers.get("x-workspace-user-id"), null);
    return new Response(JSON.stringify({ error: "email_otp_proxy_auth_required" }), {
      status: 403,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const response = await onRequest({
      env: { AUTH_WORKER_URL: "https://auth.example.test" },
      params: { path: ["email", "login", "verify"] },
      request: new Request("https://ai.example.invalid/auth/email/login/verify", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.42",
          "content-type": "application/json",
          origin: "https://ai.example.invalid",
          "x-workspace-auth-proxy-token": "attacker-proxy-token",
          "x-workspace-user-id": "attacker"
        },
        body: JSON.stringify({ challengeId: crypto.randomUUID(), code: "123456" })
      })
    });
    assert.equal(response.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
