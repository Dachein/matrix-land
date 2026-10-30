import assert from "node:assert/strict";
import { it } from "node:test";
import { chatErrorCategory, chatErrorLabel, chatPauseLabel } from "./chatErrors.ts";

it("distinguishes response, history and socket errors", () => {
  assert.equal(chatErrorCategory({ error: new Error("model") }), "reply");
  assert.equal(chatErrorCategory({ hydrationError: new Error("history") }), "history");
  assert.equal(chatErrorCategory({ connectionError: new Error("socket"), error: new Error("reply") }), "connection");
  assert.equal(chatErrorCategory({}), undefined);
  assert.doesNotMatch(chatErrorLabel("reply", true), /Connection/);
  assert.match(chatErrorLabel("reply", false), /回复失败/);
  assert.match(chatErrorLabel("history", false), /记录加载失败/);
  assert.match(chatPauseLabel("tool_pending", false), /任务已暂停/);
  assert.match(chatPauseLabel("tool_outcome_unknown", false), /先核实/);
});
