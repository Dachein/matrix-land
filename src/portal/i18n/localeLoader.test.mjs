import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearLoadedLocaleResources,
  loadLocaleResource,
  readLoadedLocaleResource
} from "./localeLoader.ts";

afterEach(() => clearLoadedLocaleResources());

describe("locale resource loader", () => {
  it("loads only the requested complete language resource", async () => {
    const zhCN = await loadLocaleResource("zh-CN");

    assert.equal(zhCN["portal.nav.home"], "首页");
    assert.equal(zhCN["knowledge.copyForAgent"], "复制提示词");
    assert.equal(readLoadedLocaleResource("zh-CN"), zhCN);
    assert.equal(readLoadedLocaleResource("en"), undefined);
  });

  it("deduplicates concurrent language loads and keeps languages independent", async () => {
    const [first, second] = await Promise.all([
      loadLocaleResource("en"),
      loadLocaleResource("en")
    ]);

    assert.equal(first, second);
    assert.equal(first["portal.nav.home"], "Home");
    assert.equal(first["knowledge.copyForAgent"], "Copy prompt");
    assert.equal(readLoadedLocaleResource("zh-CN"), undefined);
  });
});
