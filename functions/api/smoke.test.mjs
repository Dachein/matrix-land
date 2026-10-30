import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { onRequest } from "./[[route]].ts";

function makeContext(method, path, options = {}) {
  return {
    env: {WORKSPACE_MODULES_JSON: JSON.stringify(["models","studio","mate","knowledge","connections","discussions","operations"]), ...options.env},
    request: new Request(`https://portal.test/api/${path}`, {
      method,
      headers: {
        ...(options.headers ?? {}),
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    })
  };
}

async function readJson(response) {
  return response.json();
}

function decodeJwtPayload(token) {
  const [, payload] = token.split(".");
  const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

describe("pages api smoke", () => {
  it("responds to CORS preflight for an explicitly configured origin", async () => {
    const response = await onRequest(makeContext("OPTIONS", "catalog", {
      env: { CORS_ALLOWED_ORIGINS: "https://ai.example.invalid" },
      headers: {
        origin: "https://ai.example.invalid",
        "x-request-id": "preflight-1"
      }
    }));

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("x-request-id"), "preflight-1");
    assert.equal(response.headers.get("access-control-allow-origin"), "https://ai.example.invalid");
    assert.equal(response.headers.get("access-control-allow-methods"), "GET,POST,PATCH,DELETE,OPTIONS");
    assert.match(response.headers.get("access-control-allow-headers"), /X-Request-Id/);
    assert.equal(response.headers.get("access-control-expose-headers"), "X-Request-Id");
  });

  it("does not emit CORS allow-origin for untrusted origins", async () => {
    const response = await onRequest(makeContext("OPTIONS", "catalog", {
      headers: { origin: "https://evil.example.test" }
    }));

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });

  it("allows configured CORS origins at the Pages entrypoint", async () => {
    const response = await onRequest(makeContext("OPTIONS", "catalog", {
      env: { CORS_ALLOWED_ORIGINS: "https://apps.example.test" },
      headers: { origin: "https://apps.example.test" }
    }));

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://apps.example.test");
  });

  it("reports an unauthenticated session when Auth Worker is not configured", async () => {
    const response = await onRequest(makeContext("GET", "auth/session"));
    const payload = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(payload.configured, false);
    assert.equal(payload.authenticated, false);
    assert.equal(payload.loginUrl, "/auth/login");
    assert.equal(payload.logoutUrl, "/auth/logout");
    assert.equal(payload.user, undefined);
  });

  it("does not load protected catalog data without Auth Worker configuration", async () => {
    const response = await onRequest(makeContext("GET", "catalog"));
    const payload = await readJson(response);

    assert.equal(response.status, 503);
    assert.equal(payload.error, "auth_worker_url_not_configured");
  });

  it("fails closed when an authenticated catalog request has no database binding", async () => {
    const response = await withAuthWorkerSession(async () => onRequest(makeContext("GET", "catalog", {
      env: { AUTH_WORKER_URL: "https://auth.example.test" },
      headers: { cookie: "workspace_session=session-1" }
    })));
    const payload = await readJson(response);

    assert.equal(response.status, 503);
    assert.equal(payload.error, "database_not_configured");
  });

  it("keeps a valid request id consistent across a stable HttpError response", async () => {
    const response = await onRequest(makeContext("GET", "catalog", {
      headers: { "x-request-id": "catalog-error_1" }
    }));
    const payload = await readJson(response);

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-request-id"), "catalog-error_1");
    assert.deepEqual(payload, {
      error: "auth_worker_url_not_configured",
      requestId: "catalog-error_1"
    });
  });

  it("generates a UUID instead of reflecting invalid or oversized request ids", async () => {
    for (const invalidRequestId of ["contains spaces", "x".repeat(129)]) {
      const response = await onRequest(makeContext("GET", "auth/session", {
        headers: { "x-request-id": invalidRequestId }
      }));
      const responseRequestId = response.headers.get("x-request-id");

      assert.equal(response.status, 200);
      assert.notEqual(responseRequestId, invalidRequestId);
      assert.match(responseRequestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
  });

  it("propagates a generated request id to downstream services without losing method or body", async () => {
    const originalFetch = globalThis.fetch;
    let upstreamRequestId = "";

    globalThis.fetch = async (url, init = {}) => {
      const requestUrl = String(url);
      if (requestUrl === "https://auth.example.test/auth/session") {
        return authenticatedSessionResponse();
      }

      assert.equal(requestUrl, "https://apps.example.test/apps/app-1/handoff-link");
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(new TextDecoder().decode(init.body)), { name: "trace-me" });
      upstreamRequestId = new Headers(init.headers).get("x-request-id") ?? "";
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" }
      });
    };

    try {
      const response = await onRequest(makeContext("POST", "apps/apps/app-1/handoff-link", {
        body: { name: "trace-me" },
        env: {
          AUTH_WORKER_URL: "https://auth.example.test",
          APPS_JWT_SECRET: "apps-jwt-secret",
          APPS_WORKER_URL: "https://apps.example.test"
        },
        headers: { cookie: "workspace_session=session-1" }
      }));
      const responseRequestId = response.headers.get("x-request-id");

      assert.equal(response.status, 200);
      assert.match(responseRequestId, /^[0-9a-f-]{36}$/i);
      assert.equal(upstreamRequestId, responseRequestId);
      assert.deepEqual(await readJson(response), { ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("redacts unexpected SQL and secret details while logging only a safe cause", async () => {
    const originalConsoleError = console.error;
    const logs = [];
    const leakedSecret = "sk-production-secret";
    let response;

    console.error = (entry) => logs.push(entry);
    try {
      response = await withAuthWorkerSession(async () => onRequest(makeContext("GET", "catalog", {
        env: {
          AUTH_WORKER_URL: "https://auth.example.test",
          DB: {
            prepare() {
              throw new Error(`D1_ERROR: SELECT * FROM private_accounts; token=${leakedSecret}`);
            }
          }
        },
        headers: {
          cookie: "workspace_session=session-1",
          "x-request-id": "database-error-1"
        }
      })));
    } finally {
      console.error = originalConsoleError;
    }

    const responseText = await response.text();
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("x-request-id"), "database-error-1");
    assert.deepEqual(JSON.parse(responseText), {
      error: "internal_error",
      requestId: "database-error-1"
    });
    assert.doesNotMatch(responseText, /D1_ERROR|private_accounts|sk-production-secret/);
    assert.deepEqual(logs, [{
      event: "pages_api_unhandled_error",
      requestId: "database-error-1",
      cause: "Error"
    }]);
    assert.doesNotMatch(JSON.stringify(logs), /private_accounts|sk-production-secret/);
  });

  it("truncates dynamic upstream body details from HttpError responses", async () => {
    const originalFetch = globalThis.fetch;
    const upstreamSecret = "upstream-secret-response";

    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      if (requestUrl === "https://auth.example.test/auth/session") {
        return authenticatedSessionResponse();
      }
      assert.equal(requestUrl, "https://auth.example.test/v1/mcp/connections/revoke");
      return new Response(`authorization failed: ${upstreamSecret}`, { status: 502 });
    };

    try {
      const response = await onRequest(makeContext("DELETE", "mcp/connections/conn-1", {
        env: {
          AUTH_WORKER_URL: "https://auth.example.test",
          MCP_APPROVAL_TOKEN: "approval-token"
        },
        headers: {
          cookie: "workspace_session=session-1",
          "x-request-id": "upstream-error-1"
        }
      }));
      const responseText = await response.text();

      assert.equal(response.status, 502);
      assert.equal(response.headers.get("x-request-id"), "upstream-error-1");
      assert.deepEqual(JSON.parse(responseText), {
        error: "mcp_connection_revoke_failed",
        requestId: "upstream-error-1"
      });
      assert.doesNotMatch(responseText, /authorization failed|upstream-secret-response/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("adds the request id to direct route error responses", async () => {
    const response = await onRequest(makeContext("GET", "missing-route", {
      headers: { "x-request-id": "not-found-1" }
    }));

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("x-request-id"), "not-found-1");
    assert.deepEqual(await readJson(response), {
      error: "not_found",
      requestId: "not-found-1"
    });
  });

  it("issues a portal APPS token for a pre-authorized email OTP session through the real Pages route", async () => {
    const response = await withAuthWorkerSession(async () => onRequest(makeContext("POST", "apps/token", {
      body: {
        appId: "app-1",
        scopes: ["apps:apps:read", "apps:apps:write", "not:allowed"]
      },
      env: {
        AUTH_WORKER_URL: "https://auth.example.test",
        APPS_JWT_SECRET: "test-apps-secret",
        PORTAL_ISSUER: "portal-smoke",
        TOKEN_TTL_SECONDS: "1200"
      },
      headers: { cookie: "workspace_session=session-1" }
    })), "email_otp");
    const payload = await readJson(response);
    const claims = decodeJwtPayload(payload.token);

    assert.equal(response.status, 200);
    assert.equal(payload.tokenType, "Bearer");
    assert.deepEqual(payload.scopes, ["apps:apps:read", "apps:apps:write"]);
    assert.equal(claims.typ, "apps_access");
    assert.equal(claims.iss, "portal-smoke");
    assert.equal(claims.sub, "user-1");
    assert.equal(claims.app_id, "app-1");
    assert.deepEqual(claims.scopes, ["apps:apps:read", "apps:apps:write"]);
  });

  it("allows a pre-authorized active email OTP session to create its own LLM Gateway token", async () => {
    const fetchCalls = [];
    const response = await withEmailOtpGatewaySession(async () => onRequest(makeContext(
      "POST",
      "llm-gateway/access/tokens",
      {
        body: {
          monthlyBudgetPercent: 25,
          name: "email-otp-token",
          usagePurpose: "agent"
        },
        env: {
          AUTH_WORKER_URL: "https://auth.example.test",
          LITELLM_PROVISIONING_KEY: "provisioning-key",
          LITELLM_URL: "https://token.example.test"
        },
        headers: { cookie: "workspace_session=session-1" }
      }
    )), fetchCalls);
    const payload = await readJson(response);

    assert.equal(response.status, 201);
    assert.equal(payload.token, "sk-email-otp-created");
    assert.deepEqual(fetchCalls, [
      "https://auth.example.test/auth/session",
      "https://token.example.test/user/info?user_id=ada%40example.com",
      "https://token.example.test/key/generate"
    ]);
  });

  it("lets an authenticated legacy session revoke its own MCP connection", async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];

    globalThis.fetch = async (url, init = {}) => {
      const requestUrl = String(url);
      fetchCalls.push(requestUrl);

      if (requestUrl === "https://auth.example.test/auth/session") {
        assert.equal(init.headers.get("cookie"), "workspace_session=session-1");
        return new Response(JSON.stringify({
          authenticated: true,
          user: {
            id: "user-1",
            name: "Ada",
            email: "ada@example.com",
            role: "member",
            identity: {
              provider: "microsoft_entra_id",
              tenantId: "tenant-1",
              objectId: "oid-1",
              principalName: "ada@example.com"
            }
          }
        }), { headers: { "content-type": "application/json" } });
      }

      assert.equal(requestUrl, "https://auth.example.test/v1/mcp/connections/revoke");
      assert.equal(init.headers.Authorization, "Bearer approval-token");
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), {
        connectionId: "mcp-conn-1",
        user: {
          email: "ada@example.com",
          id: "user-1",
          name: "Ada",
          role: "member",
          status: "active",
          team: ""
        }
      });
      return new Response(JSON.stringify({ connectionId: "mcp-conn-1", revoked: true }), {
        headers: { "content-type": "application/json" }
      });
    };

    try {
      const response = await onRequest(makeContext("DELETE", "mcp/connections/mcp-conn-1", {
        env: {
          AUTH_WORKER_URL: "https://auth.example.test",
          MCP_APPROVAL_TOKEN: "approval-token"
        },
        headers: { cookie: "workspace_session=session-1" }
      }));
      const payload = await readJson(response);

      assert.equal(response.status, 200);
      assert.equal(payload.revoked, true);
      assert.deepEqual(fetchCalls, [
        "https://auth.example.test/auth/session",
        "https://auth.example.test/v1/mcp/connections/revoke"
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("loads MCP install config through the real Pages route", async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];

    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      return new Response(JSON.stringify({
        agents: [{
          id: "codex",
          label: "Codex",
          installPrompt: "Install Frontier Workspace MCP from https://mcp.example.test/llms.txt?for=codex.",
          llmsTxt: "https://mcp.example.test/llms.txt?for=codex"
        }],
        llmsTxt: "https://mcp.example.test/llms.txt",
        resource: "https://mcp.example.test"
      }), {
        headers: { "content-type": "application/json" }
      });
    };

    try {
      const response = await onRequest(makeContext("GET", "mcp/install/config", {
        env: { MCP_RESOURCE_URL: "https://mcp.example.test" }
      }));
      const payload = await readJson(response);

      assert.equal(response.status, 200);
      assert.deepEqual(fetchCalls, ["https://mcp.example.test/.well-known/workspace-mcp"]);
      assert.equal(payload.resource, "https://mcp.example.test");
      assert.equal(payload.llmsTxt, "https://mcp.example.test/llms.txt");
      assert.equal(payload.agents[0].id, "codex");
      assert.equal(payload.agents[0].label, "Codex");
      assert.match(payload.agents[0].installPrompt, /https:\/\/mcp\.example\.test\/mcp/);
      assert.match(payload.agents[0].installPrompt, /OAuth/);
      assert.doesNotMatch(payload.agents[0].installPrompt, /example-org|@latest/);
      assert.match(payload.agents[0].installPrompt, /ping_who_am_i/);
      assert.doesNotMatch(payload.agents[0].installPrompt, /llms\.txt/);
      assert.equal(payload.agents[0].llmsTxt, "https://mcp.example.test/llms.txt?for=codex");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function withAuthWorkerSession(callback, authenticationMethod = "microsoft_entra_id") {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://auth.example.test/auth/session");
    assert.equal(init.headers.get("cookie"), "workspace_session=session-1");

    return authenticatedSessionResponse(authenticationMethod);
  };

  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function authenticatedSessionResponse(authenticationMethod = "microsoft_entra_id") {
  return new Response(JSON.stringify({
    authenticated: true,
    user: {
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
      role: "admin",
      identity: {
        ...(authenticationMethod ? { authenticationMethod } : {}),
        provider: "microsoft_entra_id",
        tenantId: "tenant-1",
        objectId: "oid-1",
        principalName: "ada@example.com"
      }
    }
  }), {
    headers: { "content-type": "application/json" }
  });
}

async function withEmailOtpGatewaySession(callback, fetchCalls) {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    fetchCalls.push(requestUrl);

    if (requestUrl === "https://auth.example.test/auth/session") {
      assert.equal(init.headers.get("cookie"), "workspace_session=session-1");
      return new Response(JSON.stringify({
        authenticated: true,
        user: {
          id: "user-1",
          name: "Ada",
          email: "ada@example.com",
          role: "member",
          identity: {
            authenticationMethod: "email_otp",
            provider: "microsoft_entra_id",
            tenantId: "tenant-1",
            objectId: "oid-1",
            principalName: "ada@example.com"
          }
        }
      }), { headers: { "content-type": "application/json" } });
    }

    assert.equal(init.headers.Authorization, "Bearer provisioning-key");
    if (requestUrl === "https://token.example.test/user/info?user_id=ada%40example.com") {
      return new Response(JSON.stringify({
        budget_duration: "30d",
        max_budget: 100,
        models: ["model-1"],
        user_id: "ada@example.com"
      }), { headers: { "content-type": "application/json" } });
    }

    if (requestUrl === "https://token.example.test/key/generate") {
      const body = JSON.parse(String(init.body));
      assert.equal(init.method, "POST");
      assert.equal(body.key_alias, "email-otp-token");
      assert.equal(body.user_id, "ada@example.com");
      assert.equal(body.max_budget, 25);
      return new Response(JSON.stringify({
        key: "sk-email-otp-created",
        key_alias: body.key_alias,
        max_budget: body.max_budget,
        metadata: body.metadata,
        models: body.models,
        user_id: body.user_id
      }), { headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "unexpected_request" }), { status: 500 });
  };

  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
