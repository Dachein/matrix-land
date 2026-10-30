import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeGatewayUsagePurpose,
  readMoneyLimit,
  readPercentLimit,
  sanitizeAllowedModels
} from "./normalizers.ts";
import {
  normalizeLiteLlmModelCatalog,
  normalizeLiteLlmModelOptions
} from "./litellm.ts";

describe("llm gateway normalizers", () => {
  it("sanitizes gateway request inputs", () => {
    assert.deepEqual(sanitizeAllowedModels([" gpt-4.1 ", "gpt-4.1", "", "claude"]), ["gpt-4.1", "claude"]);
    assert.equal(readPercentLimit(111), 100);
    assert.equal(readPercentLimit(-5), 0);
    assert.equal(readMoneyLimit(12.34567), 12.3457);
    assert.equal(normalizeGatewayUsagePurpose("app"), "app");
    assert.equal(normalizeGatewayUsagePurpose("unknown"), "agent");
    assert.equal(normalizeGatewayUsagePurpose(undefined), "agent");
  });

  it("keeps per-model input, output, and cache pricing from LiteLLM without code-side capability defaults", () => {
    const [model] = normalizeLiteLlmModelOptions([{
      model_name: "tencent-kimi-k3",
      model_info: {
        currency: "usd",
        display_name: "Kimi K3",
        mode: "chat",
        pricing_usd_per_million_tokens: {
          cache: 0.3,
          input: 3,
          output: 15
        }
      },
      litellm_params: {
        model: "openai/kimi-k3"
      }
    }]);
    assert.deepEqual(model, {
      id: "tencent-kimi-k3",
      displayName: "Kimi K3",
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 3,
        outputPerMillionTokens: 15,
        cacheReadPerMillionTokens: 0.3
      }
    });
  });

  it("reads the Responses-only assessment stored in LiteLLM model_info", () => {
    const [model] = normalizeLiteLlmModelOptions([{
      model_name: "tencent-kimi-k3",
      model_info: {
        display_name: "Kimi K3",
        workspace_capabilities: {
          schema_version: 2,
          responses_api: "supported",
          capabilities: {
            image: "supported",
            search: "unsupported",
            file_reading: "unknown"
          }
        }
      }
    }]);

    assert.equal(model.capabilityAssessment.responses_api, "supported");
    assert.equal(model.capabilityAssessment.capabilities.image, "supported");
    assert.equal(model.capabilityAssessment.capabilities.file_reading, "unknown");
  });

  it("falls back to LiteLLM per-token costs when published pricing metadata is absent", () => {
    assert.deepEqual(normalizeLiteLlmModelOptions([{
      model_name: "tencent-example",
      model_info: {
        mode: "chat"
      },
      litellm_params: {
        cache_read_input_token_cost: 0.0000002,
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000004
      }
    }])[0].pricing, {
      currency: "USD",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 4,
      cacheReadPerMillionTokens: 0.2
    });
  });

  it("sorts model options and catalog entries alphabetically by display name", () => {
    const models = [
      ["tencent-mimo-v2.5-pro", "MiMo-V2.5-Pro"],
      ["tencent-glm-5.3", "GLM-5.3"],
      ["tencent-kimi-k3", "Kimi K3"],
      ["tencent-deepseek-v4-pro", "DeepSeek-V4-Pro"],
      ["tencent-minimax-m3", "MiniMax-M3"],
      ["tencent-deepseek-v4-flash", "DeepSeek-V4-Flash"]
    ].map(([modelName, displayName]) => ({
      model_name: modelName,
      model_info: { display_name: displayName, mode: "chat" },
      litellm_params: { model: `openai/${modelName}` }
    }));
    const expected = [
      "DeepSeek-V4-Flash",
      "DeepSeek-V4-Pro",
      "GLM-5.3",
      "Kimi K3",
      "MiMo-V2.5-Pro",
      "MiniMax-M3"
    ];

    assert.deepEqual(normalizeLiteLlmModelOptions(models).map((model) => model.displayName), expected);
    assert.deepEqual(normalizeLiteLlmModelCatalog(models).models.map((model) => model.displayName), expected);
  });

  it("keeps hidden compatibility deployments out of user and admin model catalogs", () => {
    const models = [{
      model_name: "tencent-kimi-k2.7-code",
      model_info: {
        display_name: "Kimi K2.7 Code",
        hidden: true,
        mode: "chat"
      },
      litellm_params: {
        model: "openai/kimi-k2.7-code"
      }
    }, {
      model_name: "tencent-mimo-v2.5-pro",
      model_info: {
        display_name: "MiMo-V2.5-Pro",
        mode: "chat"
      },
      litellm_params: {
        model: "openai/mimo-v2.5-pro"
      }
    }];

    assert.deepEqual(normalizeLiteLlmModelOptions(models).map((model) => model.id), [
      "tencent-mimo-v2.5-pro"
    ]);
    assert.deepEqual(normalizeLiteLlmModelCatalog(models).models.map((model) => model.id), [
      "tencent-mimo-v2.5-pro"
    ]);
  });
});
