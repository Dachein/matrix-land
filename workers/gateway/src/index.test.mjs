import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "./index.ts";

describe("llm gateway worker", () => {
  it("serves the model catalog through the existing provisioning credential", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({
        data: [{ model_name: "gpt-test", model_info: {
          mode: "chat",
          workspace_capabilities: {
            schema_version: 2,
            responses_api: "supported",
            capabilities: { image: "supported", search: "unsupported", file_reading: "unknown" }
          }
        } }]
      }), { status: 200 });
    };
    try {
      const response = await worker.fetch(new Request("https://internal/internal/models"), {
        DB: {},
        LITELLM_URL: "https://token.example.test",
        LITELLM_PROVISIONING_KEY: "existing-provisioning-key"
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.models[0].id, "gpt-test");
      assert.equal(body.models[0].capabilityAssessment.responses_api, "supported");
      assert.equal(body.models[0].capabilities.vision.state, "supported");
      assert.deepEqual(calls.map((call) => call.input).sort(), [
        "https://token.example.test/v1/model/info",
        "https://token.example.test/v1/models"
      ]);
      assert.equal(calls[0].init.headers.Authorization, "Bearer existing-provisioning-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("publishes only active recommended models and separates working hidden models", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/models") {
        return Response.json({ data: [
          { id: "visible-model" },
          { id: "hidden-working-model" }
        ] });
      }
      return Response.json({ data: [
        { model_name: "visible-model", model_info: { mode: "chat", supports_vision: null } },
        { model_name: "hidden-working-model", model_info: { mode: "chat", hidden: true } },
        { model_name: "blocked-model", model_info: { mode: "chat", blocked: true } }
      ] });
    };
    try {
      const response = await worker.fetch(new Request("https://internal/internal/models"), {
        DB: {},
        LITELLM_URL: "https://token.example.test",
        LITELLM_PROVISIONING_KEY: "existing-provisioning-key"
      });
      const body = await response.json();
      assert.deepEqual(body.models.map((model) => model.id), ["visible-model"]);
      assert.deepEqual(body.hiddenModels.map((model) => model.id), ["hidden-working-model"]);
      assert.equal(body.models[0].capabilities.vision.state, "unknown");
      assert.equal(body.models[0].capabilities.vision.source, "declared");
      assert.equal(body.models.some((model) => model.id === "blocked-model"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not require a second model-list token", async () => {
    await assert.rejects(
      () => worker.fetch(new Request("https://internal/internal/models"), {
        DB: {},
        LITELLM_URL: "https://token.example.test"
      }),
      /litellm_provisioning_key_not_configured/
    );
  });
});
