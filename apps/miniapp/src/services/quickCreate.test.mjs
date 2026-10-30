import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MateProvisionIncompleteError, quickMateCode, quickCreateErrorMessage } from "./quickCreate.ts";

describe("miniapp quick creation", () => {
  it("gives repeated display names distinct valid mailbox codes", () => {
    const first = quickMateCode("小 Y", 1790141000000, 0.1);
    const second = quickMateCode("小 Y", 1790141000000, 0.2);
    assert.notEqual(first, second);
    assert.match(first, /^y-[a-z0-9]+-[a-z0-9]+$/);
  });

  it("supports all-Chinese and long names within a mailbox local part", () => {
    assert.match(quickMateCode("小法", 1790141000000, 0), /^mini-[a-z0-9]+-0+$/);
    assert.ok(quickMateCode("A".repeat(100), 1790141000000, 0).length <= 64);
  });

  it("turns backend conflicts into a visible creation error", () => {
    assert.match(quickCreateErrorMessage(new Error("mate_email_conflict")), /冲突/);
    assert.match(quickCreateErrorMessage(new Error("mate_email_conflict"), "en"), /already in use/i);
    assert.match(quickCreateErrorMessage(new Error("http_500")), /创建失败/);
    assert.match(quickCreateErrorMessage(new MateProvisionIncompleteError("test-id", new Error("http_500"))), /已保存/);
  });
});
