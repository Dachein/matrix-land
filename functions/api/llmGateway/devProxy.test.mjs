import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlmGatewayDevProxyApi } from "./devProxy.ts";

const adminUser = {
  id: "admin-1",
  name: "Ada",
  email: "ada@example.com",
  team: "AI Adoption",
  role: "admin",
  identity: {
    provider: "microsoft_entra_id",
    objectId: "oid-1",
    tenantId: "tenant-1"
  }
};

function makeDeps(overrides = {}) {
  return {
    baseUrl() {
      return "https://llm.example.com";
    },
    json(body, init = {}) {
      return new Response(JSON.stringify(body), init);
    },
    parseJson(value) {
      return JSON.parse(value);
    },
    async readBody(request) {
      return request.headers.get("content-type")?.includes("json") ? request.json() : {};
    },
    async requireAdminPortalUser() {
      return adminUser;
    },
    requireSecret(value, name) {
      const text = String(value ?? "").trim();
      if (!text) {
        throw Object.assign(new Error(`${name}_not_configured`), { status: 503 });
      }
      return text;
    },
    ...overrides
  };
}

describe("llm gateway dev proxy service", () => {
  it("loads the admin model catalog with the gateway admin token", async () => {
    const calls = [];
    const api = createLlmGatewayDevProxyApi(makeDeps({
      async fetch(url, init) {
        calls.push({ url, init });
        return new Response(JSON.stringify({
          data: [
            {
              model_name: "gpt-4.1",
              model_info: {
                id: "gpt-4.1",
                display_name: "GPT 4.1",
                provider: "openai",
                mode: "chat",
                blocked: false
              }
            },
            {
              model_name: "tencent-deepseek-v4-pro",
              model_info: {
                id: "tencent-deepseek-v4-pro",
                display_name: "DeepSeek-V4-Pro (LiteLLM)",
                provider: "tencent-tokenhub-intl",
                mode: "chat",
                blocked: false
              }
            }
          ]
        }), {
          headers: { "content-type": "application/json" }
        });
      }
    }));

    const response = await api.getModelCatalog({
      request: new Request("https://portal.test/api/llm-gateway/model-catalog"),
      env: { LITELLM_MASTER_KEY: "admin-token" }
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.gatewayUrl, "https://llm.example.com");
    assert.equal(body.catalog.version, "litellm");
    assert.equal(body.catalog.models[0].id, "tencent-deepseek-v4-pro");
    assert.equal(body.catalog.models[0].displayName, "DeepSeek-V4-Pro (LiteLLM)");
    assert.equal(body.catalog.models[0].vendorRoutes["tencent-tokenhub-intl"].status, "active");
    assert.equal(body.catalog.models[1].id, "gpt-4.1");
    assert.equal(body.catalog.models[1].displayName, "GPT 4.1");
    assert.equal(calls[0].url, "https://llm.example.com/v1/model/info");
    assert.equal(calls[0].init.headers.Authorization, "Bearer admin-token");
    assert.equal(calls[0].init.headers.Accept, "application/json");
  });

  it("maps catalog upstream failures to a stable portal response", async () => {
    const api = createLlmGatewayDevProxyApi(makeDeps({
      async fetch() {
        return new Response("upstream down", { status: 503 });
      }
    }));

    const response = await api.getModelCatalog({
      request: new Request("https://portal.test/api/llm-gateway/model-catalog"),
      env: { LITELLM_MASTER_KEY: "admin-token" }
    });
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.deepEqual(body, {
      error: "llm_gateway_catalog_unavailable",
      upstreamStatus: 503,
      upstreamBody: "upstream down"
    });
  });

  it("proxies chat completions with the user token and preserves response metadata", async () => {
    const calls = [];
    const api = createLlmGatewayDevProxyApi(makeDeps({
      async fetch(url, init) {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ id: "chatcmpl_1" }), {
          status: 201,
          statusText: "Created",
          headers: {
            "content-type": "application/json",
            "x-request-id": "gateway-request-1",
            "cf-ray": "ray-1"
          }
        });
      }
    }));

    const response = await api.runChat({
      request: new Request("https://portal.test/api/llm-gateway/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4.1", messages: [] })
      }),
      env: { LITELLM_USER_TOKEN: "user-token" }
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("x-request-id"), "gateway-request-1");
    assert.equal(response.headers.get("cf-ray"), "ray-1");
    assert.deepEqual(body, { id: "chatcmpl_1" });
    assert.equal(calls[0].url, "https://llm.example.com/v1/chat/completions");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer user-token");
    assert.deepEqual(calls[0].body, { model: "gpt-4.1", messages: [] });
  });
});
