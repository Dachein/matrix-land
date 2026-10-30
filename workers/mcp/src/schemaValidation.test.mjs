import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WORKSPACE_MCP_VERSION } from "../../../src/shared/mcpHandbook.ts";
import { validateJsonSchema } from "./schemaValidation.ts";
import { callPublicMcpTool } from "./tools.ts";

describe("Cloudflare-safe JSON Schema validation", () => {
  const schema = {
    type: "object",
    required: ["name", "target"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 2, maxLength: 8 },
      count: { type: "integer", minimum: 1, maximum: 3 },
      labels: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } },
      metadata: { type: "object", additionalProperties: { type: "string" } },
      target: { type: "string", enum: ["topic", "reply"] }
    },
    anyOf: [{ required: ["count"] }, { required: ["labels"] }]
  };

  it("accepts a nested value without dynamic code generation", () => {
    assert.deepEqual(validateJsonSchema(schema, {
      name: "Example",
      labels: ["mcp"],
      metadata: { client: "workbuddy" },
      target: "topic"
    }), []);
  });

  it("reports required, additional, type, range, and enum failures", () => {
    const issues = validateJsonSchema(schema, {
      count: 4.5,
      extra: true,
      name: "x",
      target: "unknown"
    });
    assert.deepEqual([...new Set(issues.map((issue) => issue.keyword))].sort(), [
      "additionalProperties",
      "enum",
      "minLength",
      "type"
    ]);
  });

  it("enforces oneOf and action-specific nested object strictness", () => {
    const actionSchema = {
      type: "object",
      oneOf: [
        { required: ["topicId"] },
        { required: ["replyId"] }
      ],
      properties: {
        topicId: { type: "string" },
        replyId: { type: "string" }
      },
      additionalProperties: false
    };
    assert.equal(validateJsonSchema(actionSchema, { topicId: "topic-1" }).length, 0);
    assert.equal(validateJsonSchema(actionSchema, {}).some((issue) => issue.keyword === "oneOf"), true);
    assert.equal(
      validateJsonSchema(actionSchema, { topicId: "topic-1", replyId: "reply-1" })
        .some((issue) => issue.keyword === "oneOf"),
      true
    );
  });

  it("runs the real public ping route when string code generation is disabled", async () => {
    const result = await callPublicMcpTool("ping_who_am_i", {}, {}, {
      agentType: "workbuddy",
      email: "ada@example.invalid",
      name: "Ada",
      scopes: [],
      sub: "user-1"
    });
    assert.equal(result.authenticated, true);
    assert.equal(result.connection.agentType, "workbuddy");
    assert.equal(result.server.version, WORKSPACE_MCP_VERSION);
  });
});
