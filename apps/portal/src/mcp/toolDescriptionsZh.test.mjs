import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpTools } from "../../../../workers/mcp/src/tools.ts";
import {
  hasToolDescriptionZh,
  toolDescriptionZh,
  toolMatchesHandbookQuery
} from "./toolDescriptionsZh.ts";

describe("MCP Handbook Chinese tool descriptions", () => {
  it("covers every formal tool in the current MCP Handbook catalog", async () => {
    const formalTools = (await mcpTools()).filter((tool) => tool.name !== "ping_who_am_i");
    const missingNames = formalTools
      .filter((tool) => !hasToolDescriptionZh(tool.name))
      .map((tool) => tool.name);
    const nonChineseNames = formalTools
      .filter((tool) => !/\p{Script=Han}/u.test(toolDescriptionZh(tool.name)))
      .map((tool) => tool.name);

    assert.equal(formalTools.length > 0, true);
    assert.deepEqual(missingNames, []);
    assert.deepEqual(nonChineseNames, []);
  });

  it("matches tool names and descriptions in either language", () => {
    const tool = {
      name: "knowledge_query",
      description: "Search a Knowledge Service with a natural-language query."
    };

    assert.equal(toolMatchesHandbookQuery(tool, "knowledge_query"), true);
    assert.equal(toolMatchesHandbookQuery(tool, "natural-language"), true);
    assert.equal(toolMatchesHandbookQuery(tool, "知识库"), true);
    assert.equal(toolMatchesHandbookQuery(tool, "ＫＮＯＷＬＥＤＧＥ"), true);
    assert.equal(toolMatchesHandbookQuery(tool, "不存在的工具"), false);
    assert.equal(toolMatchesHandbookQuery(tool, "  "), true);
  });

  it("provides a deterministic Chinese fallback for future tools", () => {
    assert.match(toolDescriptionZh("knowledge_query"), /知识库/);
    assert.match(toolDescriptionZh("apps_database"), /Migration/);
    assert.equal(
      toolDescriptionZh("future_tool"),
      "调用 future_tool 对应的 Workspace MCP 功能。"
    );
  });
});
