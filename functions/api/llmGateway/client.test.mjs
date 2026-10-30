import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlmGatewayClient, llmGatewayBaseUrl } from "./client.ts";

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

describe("llm gateway client", () => {
  it("normalizes the gateway base URL", () => {
    assert.throws(() => llmGatewayBaseUrl({}), /LITELLM_URL/);
    assert.equal(llmGatewayBaseUrl({ LITELLM_URL: "https://token.example.com///" }), "https://token.example.com");
  });

  it("uses only the configured provisioning credential for Portal admin JSON requests", async () => {
    let upstreamRequest;
    const client = createLlmGatewayClient({
      httpError,
      async fetch(url, init) {
        upstreamRequest = { url, init };
        return new Response(JSON.stringify({ data: [{ id: "tok_1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const payload = await client.adminJson({
      request: new Request("https://portal.test/api/llm-gateway/access"),
      env: {
        LITELLM_MASTER_KEY: "master-secret",
        LITELLM_PROVISIONING_KEY: "provisioning-secret",
        LITELLM_URL: "https://token.example.com/"
      }
    }, "/admin/tokens", {
      method: "POST",
      body: { name: "Portal Token" }
    });

    assert.deepEqual(payload, { data: [{ id: "tok_1" }] });
    assert.equal(upstreamRequest.url, "https://token.example.com/admin/tokens");
    assert.equal(upstreamRequest.init.method, "POST");
    assert.equal(upstreamRequest.init.headers.Authorization, "Bearer provisioning-secret");
    assert.equal(upstreamRequest.init.headers.Accept, "application/json");
    assert.equal(upstreamRequest.init.headers["Content-Type"], "application/json");
    assert.equal(upstreamRequest.init.body, JSON.stringify({ name: "Portal Token" }));
  });

  it("requires a provisioning credential and never falls back to a master key", async () => {
    const authorizations = [];
    const client = createLlmGatewayClient({
      httpError,
      async fetch(_url, init) {
        authorizations.push(init.headers.Authorization);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    for (const [env, expectedAuthorization] of [
      [{ LITELLM_PROVISIONING_KEY: "provisioning-only" }, "Bearer provisioning-only"],
      [{ LITELLM_MASTER_KEY: "   ", LITELLM_PROVISIONING_KEY: "provisioning-fallback" }, "Bearer provisioning-fallback"]
    ]) {
      assert.deepEqual(await client.adminJson({
        request: new Request("https://portal.test/api/llm-gateway/access"),
        env: { LITELLM_URL: "https://token.example.invalid", ...env }
      }, "/key/list"), { ok: true });
      assert.equal(authorizations.at(-1), expectedAuthorization);
    }

    assert.equal(authorizations.length, 2);
    await assert.rejects(() => client.adminJson({env:{LITELLM_URL:"https://token.example.invalid",LITELLM_MASTER_KEY:"master-only"}}, "/key/list"), /litellm_provisioning_key_not_configured/);
  });

  it("rejects missing admin credentials before making an upstream request", async () => {
    let fetchCalls = 0;
    const client = createLlmGatewayClient({
      httpError,
      async fetch() {
        fetchCalls += 1;
        return new Response(JSON.stringify({ ok: true }));
      }
    });

    await assert.rejects(
      () => client.adminJson({
        request: new Request("https://portal.test/api/llm-gateway/access"),
        env: { LITELLM_URL: "https://token.example.invalid" }
      }, "/key/list"),
      (error) => error.status === 503 && error.message === "litellm_provisioning_key_not_configured"
    );
    assert.equal(fetchCalls, 0);
  });

  it("maps upstream auth failures to a portal 502 without retrying with provisioning", async () => {
    const authorizations = [];
    const client = createLlmGatewayClient({
      httpError,
      async fetch(_url, init) {
        authorizations.push(init.headers.Authorization);
        return new Response("bad token", { status: 401 });
      }
    });

    await assert.rejects(
      () => client.adminJson({
        request: new Request("https://portal.test/api/llm-gateway/access"),
        env: {
          LITELLM_MASTER_KEY: "master-secret",
          LITELLM_PROVISIONING_KEY: "provisioning-secret",
          LITELLM_URL: "https://token.example.com"
        }
      }, "/admin/tokens"),
      (error) => error.status === 502 && error.message === "llm_gateway_admin_request_failed:401"
    );
    assert.deepEqual(authorizations, ["Bearer provisioning-secret"]);
  });

  it("bounds slow upstream reads and reports a stable timeout", async () => {
    const events = [];
    const client = createLlmGatewayClient({
      httpError,
      onAdminError(event) {
        events.push(event);
      },
      async fetch(_url, init) {
        return await new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          }, { once: true });
        });
      }
    });

    await assert.rejects(
      () => client.adminJson({
        request: new Request("https://portal.test/api/llm-gateway/access", {
          headers: { "x-request-id": "portal-timeout-1" }
        }),
        env: { LITELLM_URL: "https://token.example.invalid", LITELLM_PROVISIONING_KEY: "admin-secret" }
      }, "/key/list?user_id=usr_1", { timeoutMs: 5 }),
      (error) => error.status === 504 && error.message === "llm_gateway_admin_timeout"
    );
    assert.deepEqual(events, [{
      code: "llm_gateway_admin_request_timeout",
      endpoint: "/key/list",
      requestId: "portal-timeout-1",
      upstreamStatus: 0
    }]);
  });

  it("maps upstream network failures to a stable unavailable response", async () => {
    const events = [];
    const client = createLlmGatewayClient({
      httpError,
      onAdminError(event) {
        events.push(event);
      },
      async fetch() {
        throw new TypeError("private upstream network details");
      }
    });

    await assert.rejects(
      () => client.adminJson({
        request: new Request("https://portal.test/api/llm-gateway/access"),
        env: { LITELLM_URL: "https://token.example.invalid", LITELLM_PROVISIONING_KEY: "admin-secret" }
      }, "/user/info"),
      (error) => error.status === 502
        && error.message === "llm_gateway_admin_unavailable"
        && !error.message.includes("private upstream network details")
    );
    assert.deepEqual(events, [{
      code: "llm_gateway_admin_request_failed",
      endpoint: "/user/info",
      requestId: "",
      upstreamStatus: 0
    }]);
  });

  it("maps LiteLLM key alias conflicts to a stable 409 without exposing the alias", async () => {
    const events = [];
    const client = createLlmGatewayClient({
      httpError,
      onAdminError(event) {
        events.push(event);
      },
      async fetch() {
        return new Response(JSON.stringify({
          error: {
            code: "400",
            message: "Key with alias 'private-customer-key' already exists. Unique key aliases across all keys are required.",
            param: "key_alias"
          }
        }), {
          status: 400,
          headers: { "x-request-id": "req-conflict-1" }
        });
      }
    });

    for (const endpoint of ["/key/generate", "/key/update"]) {
      await assert.rejects(
        () => client.adminJson({
          request: new Request("https://portal.test/api/llm-gateway/access/tokens"),
          env: { LITELLM_URL: "https://token.example.invalid", LITELLM_PROVISIONING_KEY: "admin-secret" }
        }, endpoint, { method: "POST" }),
        (error) => error.status === 409
          && error.message === "gateway_token_name_conflict"
          && !error.message.includes("private-customer-key")
      );
    }
    assert.deepEqual(events, ["/key/generate", "/key/update"].map((endpoint) => ({
      code: "gateway_token_name_conflict",
      endpoint,
      requestId: "req-conflict-1",
      upstreamStatus: 400
    })));
  });

  it("does not misclassify LiteLLM key alias format errors as conflicts", async () => {
    const client = createLlmGatewayClient({
      httpError,
      async fetch() {
        return new Response(JSON.stringify({
          error: {
            message: "Invalid key_alias format. Must start and end with an alphanumeric character.",
            param: "key_alias"
          }
        }), { status: 400 });
      }
    });

    await assert.rejects(
      () => client.adminJson({
        request: new Request("https://portal.test/api/llm-gateway/access/tokens"),
        env: { LITELLM_URL: "https://token.example.invalid", LITELLM_PROVISIONING_KEY: "admin-secret" }
      }, "/key/generate", { method: "POST" }),
      (error) => error.status === 400
        && error.message === "llm_gateway_admin_request_failed:400"
        && !error.message.includes("Invalid key_alias format")
    );
  });

  it("rejects missing secrets and invalid JSON with stable portal errors", async () => {
    const missingSecretClient = createLlmGatewayClient({ httpError });

    assert.throws(
      () => missingSecretClient.requireSecret("", "litellm_provisioning_key"),
      (error) => error.status === 503 && error.message === "litellm_provisioning_key_not_configured"
    );

    const invalidJsonClient = createLlmGatewayClient({
      httpError,
      async fetch() {
        return new Response("not json", { status: 200 });
      }
    });

    await assert.rejects(
      () => invalidJsonClient.adminJson({
        request: new Request("https://portal.test/api/llm-gateway/access"),
        env: {
          LITELLM_PROVISIONING_KEY: "admin-secret",
          LITELLM_URL: "https://token.example.com"
        }
      }, "/admin/tokens"),
      (error) => error.status === 502 && error.message === "llm_gateway_invalid_json"
    );
  });
});
