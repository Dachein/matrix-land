import assert from "node:assert/strict";
import { test } from "node:test";
import { loadChatHistory } from "./chatHistory.ts";
const grant = { grant: "old", expiresAt: "2099-01-01" };
const message = (id) => ({ id, role: "user", parts: [{ type: "text", text: id }] });
test("loads every history page beyond 100 messages in order", async () => {
  const all = Array.from({ length: 127 }, (_, i) => message(`m-${i}`));
  const cursors = [];
  const result = await loadChatHistory(grant, {
    page: async (_grant, cursor) => {
      cursors.push(cursor);
      const start = cursor ? Number(cursor.slice(2)) + 1 : 0;
      const data = all.slice(start, start + 50);
      return { data, headers: start + data.length < all.length ? { "X-Workspace-Chat-Next-Cursor": data.at(-1).id } : {} };
    }, refreshGrant: async () => { throw new Error("not needed"); }
  });
  assert.deepEqual(result, all);
  assert.deepEqual(cursors, [undefined, "m-49", "m-99"]);
});
test("refreshes an expired grant without losing previous pages", async () => {
  let refreshes = 0;
  const result = await loadChatHistory(grant, {
    page: async (active, cursor) => {
      if (cursor && active.grant === "old") throw { status: 401 };
      return cursor ? { data: [message("two")], headers: {} } : { data: [message("one")], headers: { "x-workspace-chat-next-cursor": "one" } };
    }, refreshGrant: async () => { refreshes++; return { ...grant, grant: "new" }; }
  });
  assert.equal(result.length, 2); assert.equal(refreshes, 1);
});
test("rejects looping or duplicated history instead of silently truncating", async () => {
  await assert.rejects(loadChatHistory(grant, { page: async () => ({ data: [message("one")], headers: { "X-Workspace-Chat-Next-Cursor": "one" } }), refreshGrant: async () => grant }), /history_invalid/);
  await assert.rejects(loadChatHistory(grant, { page: async () => ({ data: {}, headers: {} }), refreshGrant: async () => grant }), /history_invalid/);
});
