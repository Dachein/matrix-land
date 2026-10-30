import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createMessageCache } from "./messageCache.ts";

describe("miniapp persistent message cache", () => {
  let cache;
  let storage;
  beforeEach(() => {
    storage = { value: undefined, read() { return this.value; }, write(value) { this.value = value; }, clear() { this.value = undefined; } };
    cache = createMessageCache(storage);
  });

  it("restores a recent snapshot after recreating the cache and isolates accounts", () => {
    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }];
    cache.set("user-1", "mate-1", "conversation-1", messages, 1000);
    const afterRestart = createMessageCache(storage);
    assert.deepEqual(afterRestart.get("user-1", "mate-1", "conversation-1", 2000), messages);
    assert.equal(afterRestart.get("user-2", "mate-1", "conversation-1", 2000), undefined);
    assert.equal(afterRestart.get("user-1", "mate-2", "conversation-1", 2000), undefined);
  });

  it("keeps entries for 30 days, then expires them, and caches visible results without tool/thinking traces", () => {
    const messages = [{ id: "m1", role: "assistant", parts: [
      { type: "text", text: "answer" },
      { type: "data-result", data: { summary: "visible result" } },
      { type: "reasoning", text: "private draft" },
      { type: "tool-call", state: "approval-requested", input: { secret: true }, approval: { id: "approval-1" } },
      { type: "tool-call", state: "output-available", input: { secret: true }, output: { secret: true } }
    ] }];
    cache.set("user-1", "mate-1", "conversation-1", messages, 1000);
    assert.deepEqual(cache.get("user-1", "mate-1", "conversation-1", 1001)?.[0].parts, [
      { type: "text", text: "answer" },
      { type: "data-result", data: { summary: "visible result" } }
    ]);
    assert.deepEqual(cache.get("user-1", "mate-1", "conversation-1", 1000 + 30 * 24 * 60 * 60 * 1000), [
      { id: "m1", role: "assistant", parts: [
        { type: "text", text: "answer" },
        { type: "data-result", data: { summary: "visible result" } }
      ] }
    ]);
    assert.equal(cache.get("user-1", "mate-1", "conversation-1", 1001 + 30 * 24 * 60 * 60 * 1000), undefined);
  });

  it("removes the persisted cache on logout cleanup", () => {
    cache.set("user-1", "mate-1", "conversation-1", [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }], 1000);
    cache.clear();
    assert.equal(storage.value, undefined);
  });
});
