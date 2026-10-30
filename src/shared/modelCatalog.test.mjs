import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildModelCatalog,
  capabilityStateFromDeclaration,
  modelCatalogRowsFromPayload,
  MODEL_CATALOG_CAPABILITY_KEYS,
  normalizeModelCatalogEntry
} from "./modelCatalog.ts";

describe("LLM gateway model catalog", () => {
  it("never renders an undeclared capability as unsupported", () => {
    const entry = normalizeModelCatalogEntry({
      model_name: "tencent-glm-5.3-flash",
      model_info: {
        litellm_provider: "openai",
        supported_endpoints: null,
        supports_pdf_input: null,
        supports_url_context: null,
        supports_vision: null,
        supports_web_search: null
      }
    });

    for (const key of MODEL_CATALOG_CAPABILITY_KEYS) {
      assert.equal(entry.capabilities[key].state, "unknown", `${key} must stay unknown`);
      assert.notEqual(entry.capabilities[key].state, "unsupported");
    }
    assert.equal(entry.endpoints.responsesApi, "unknown");
    assert.equal(entry.endpoints.messagesApi, "unknown");
    assert.equal(entry.endpoints.chatCompletions, "unknown");
  });

  it("keeps an explicit declaration as supported or unsupported", () => {
    assert.equal(capabilityStateFromDeclaration(true), "supported");
    assert.equal(capabilityStateFromDeclaration(false), "unsupported");
    assert.equal(capabilityStateFromDeclaration(null), "unknown");
    assert.equal(capabilityStateFromDeclaration(undefined), "unknown");
    assert.equal(capabilityStateFromDeclaration(""), "unknown");
    assert.equal(capabilityStateFromDeclaration("true"), "unknown");

    const entry = normalizeModelCatalogEntry({
      model_name: "tencent-glm-5.3-flash",
      model_info: {
        supported_endpoints: ["/v1/responses"],
        supports_web_search: true,
        supports_vision: false
      }
    });

    assert.deepEqual(entry.capabilities.webSearch, { source: "declared", state: "supported" });
    assert.deepEqual(entry.capabilities.vision, { source: "declared", state: "unsupported" });
    assert.equal(entry.endpoints.responsesApi, "supported");
    assert.equal(entry.endpoints.messagesApi, "unsupported");
  });

  it("uses LiteLLM Workspace metadata for Responses API and its capabilities", () => {
    const entry = normalizeModelCatalogEntry({
      model_name: "tencent-capability-test",
      model_info: {
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
    });

    assert.equal(entry.capabilityAssessment.responses_api, "supported");
    assert.equal(entry.capabilityAssessment.capabilities.image, "supported");
    assert.equal(entry.endpoints.responsesApi, "supported");
    assert.deepEqual(entry.capabilities.vision, { source: "verified", state: "supported" });
    assert.deepEqual(entry.capabilities.webSearch, { source: "verified", state: "unsupported" });
    assert.deepEqual(entry.capabilities.pdfInput, { source: "declared", state: "unknown" });
  });

  it("does not claim a Responses capability when the endpoint is unavailable", () => {
    const entry = normalizeModelCatalogEntry({
      model_name: "tencent-no-responses",
      model_info: {
        supports_vision: true,
        workspace_capabilities: {
          schema_version: 2,
          responses_api: "unsupported",
          capabilities: { image: "unknown", search: "unknown", file_reading: "unknown" }
        }
      }
    });

    assert.equal(entry.endpoints.responsesApi, "unsupported");
    assert.equal(entry.capabilities.vision.state, "unsupported");
    assert.equal(entry.capabilities.webSearch.state, "unsupported");
    assert.equal(entry.capabilities.pdfInput.state, "unsupported");
  });

  it("normalizes pricing, context, and provider from published fields", () => {
    const entry = normalizeModelCatalogEntry({
      model_name: "tencent-hy4-preview",
      model_info: {
        display_name: "Hunyuan 4 Preview",
        input_cost_per_token: 0.00000083,
        max_input_tokens: 1_000_000,
        max_output_tokens: 1_000_000,
        output_cost_per_token: 0.0000025
      }
    });

    assert.equal(entry.displayName, "Hunyuan 4 Preview");
    assert.equal(entry.provider, "tencent-tokenhub-intl");
    assert.equal(entry.context.maxInputTokens, 1_000_000);
    assert.equal(entry.context.maxOutputTokens, 1_000_000);
    assert.equal(entry.pricing.currency, "USD");
    assert.equal(entry.pricing.inputPerMillionTokens, 0.83);
    assert.equal(entry.pricing.outputPerMillionTokens, 2.5);
  });

  it("reads rows from either documented payload shape", () => {
    assert.deepEqual(modelCatalogRowsFromPayload({ data: [{ model_name: "a" }] }).length, 1);
    assert.deepEqual(modelCatalogRowsFromPayload({ models: [{ id: "b" }] }).length, 1);
    assert.deepEqual(modelCatalogRowsFromPayload([{ id: "c" }]).length, 1);
    assert.deepEqual(modelCatalogRowsFromPayload({}), []);
    assert.deepEqual(modelCatalogRowsFromPayload(null), []);
  });

  it("counts hidden and undeclared models without claiming full coverage", () => {
    const catalog = buildModelCatalog({
      data: [
        { model_name: "glm", model_info: { hidden: true } },
        { model_name: "glm-flash", model_info: {} },
        { model_name: "glm-flash", model_info: { display_name: "duplicate id" } },
        { model_name: "hy4", model_info: { supports_web_search: true } }
      ]
    }, { catalogVersion: "1.6.0", generatedAt: "2026-09-22T00:00:00.000Z" });

    assert.equal(catalog.source.modelCount, 2);
    assert.equal(catalog.source.hiddenModelCount, 1);
    assert.equal(catalog.source.importedFrom, "/v1/model/info");
    assert.equal(catalog.catalogVersion, "1.6.0");
    assert.equal(catalog.generatedAt, "2026-09-22T00:00:00.000Z");
    assert.deepEqual(catalog.models.map((model) => model.id), ["glm-flash", "hy4"]);
    assert.equal(catalog.models[0].capabilities.webSearch.state, "unknown");
    assert.equal(catalog.models[1].capabilities.webSearch.state, "supported");
    assert.equal(
      catalog.summary.undeclaredCapabilityCount,
      catalog.models.length * MODEL_CATALOG_CAPABILITY_KEYS.length - 1
    );
    assert.equal(catalog.summary.verifiedCapabilityCount, 0);
  });
});
