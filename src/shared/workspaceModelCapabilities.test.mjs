import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isWorkspaceModelCapabilityAssessmentComplete,
  normalizeWorkspaceModelCapabilities
} from "./workspaceModelCapabilities.ts";

describe("LiteLLM Workspace model capability metadata", () => {
  const complete = {
    schema_version: 2,
    responses_api: "supported",
    capabilities: {
      image: "supported",
      search: "unsupported",
      file_reading: "supported"
    }
  };

  it("normalizes the Responses-only assessment", () => {
    assert.deepEqual(normalizeWorkspaceModelCapabilities(JSON.stringify(complete)), complete);
    assert.equal(isWorkspaceModelCapabilityAssessmentComplete(complete), true);
  });

  it("requires all three capability conclusions when Responses is supported", () => {
    assert.equal(isWorkspaceModelCapabilityAssessmentComplete({
      ...complete,
      capabilities: { ...complete.capabilities, file_reading: "unknown" }
    }), false);
    assert.equal(isWorkspaceModelCapabilityAssessmentComplete({
      schema_version: 2,
      responses_api: "unsupported",
      capabilities: { image: "unknown", search: "unknown", file_reading: "unknown" }
    }), true);
  });

  it("rejects the old two-route schema rather than silently aggregating it", () => {
    assert.equal(normalizeWorkspaceModelCapabilities({
      schema_version: 1,
      capabilities: { image: { chat_completions: "supported", responses: "supported" } }
    }), undefined);
    assert.equal(normalizeWorkspaceModelCapabilities("not-json"), undefined);
    assert.equal(isWorkspaceModelCapabilityAssessmentComplete({
      schema_version: 2,
      responses_api: "unknown",
      capabilities: complete.capabilities
    }), false);
  });
});
