import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { en } from "../../../../src/portal/i18n/resources.en.ts";
import { zhCN } from "../../../../src/portal/i18n/resources.zh-CN.ts";
import {
  LATEST_FEATURE_LIMIT,
  MCP_HANDBOOK_MODULES,
  handbookModule,
  latestHandbookFeatures,
  localizedHandbookCopy
} from "./handbookView.ts";

describe("MCP Handbook view model", () => {
  it("shows only the ten most recent features without mutating the catalog", () => {
    const features = Array.from({ length: 14 }, (_, index) => ({ id: `feature-${index + 1}` }));
    const visible = latestHandbookFeatures(features);

    assert.equal(LATEST_FEATURE_LIMIT, 10);
    assert.deepEqual(visible.map((feature) => feature.id), features.slice(0, 10).map((feature) => feature.id));
    assert.equal(features.length, 14);
  });

  it("keeps the merged Forum & Hub and standalone AI tools modules in order", () => {
    assert.deepEqual(MCP_HANDBOOK_MODULES.map((module) => module.id), [
      "forum-hub",
      "knowledge",
      "apps",
      "tools"
    ]);
    assert.equal(new Set(MCP_HANDBOOK_MODULES.map((module) => module.id)).size, 4);
  });

  it("provides primary and secondary copy in both supported locales", () => {
    for (const module of MCP_HANDBOOK_MODULES) {
      assert.equal(module.description.en, en[`mcp.handbook.groupSummary.${module.id}`]);
      assert.equal(module.description.zhCN, zhCN[`mcp.handbook.groupSummary.${module.id}`]);

      assert.deepEqual(localizedHandbookCopy("en", module.description), {
        primary: module.description.en,
        secondary: module.description.zhCN,
        secondaryLocale: "zh-CN"
      });
      assert.deepEqual(localizedHandbookCopy("zh-CN", module.description), {
        primary: module.description.zhCN,
        secondary: module.description.en,
        secondaryLocale: "en"
      });
      assert.equal(handbookModule(module.id), module);
    }
  });
});
