import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadAttachmentBatch } from "./attachmentQueue.ts";
test("preserves successful files and retries only failed uploads", async () => {
  const files = [{ name: "one", path: "one" }, { name: "two", path: "two" }];
  const first = await uploadAttachmentBatch(files, async (file) => {
    if (file.name === "two") throw new Error("network");
    return { objectId: "saved-one", fileName: file.name };
  });
  assert.equal(first.uploaded[0].objectId, "saved-one");
  assert.equal(first.failed[0].file.name, "two");
  const calls = [];
  const retry = await uploadAttachmentBatch(first.failed.map((item) => item.file), async (file) => { calls.push(file.name); return { objectId: "saved-two", fileName: file.name }; });
  assert.deepEqual(calls, ["two"]); assert.equal(retry.uploaded.length, 1);
});
