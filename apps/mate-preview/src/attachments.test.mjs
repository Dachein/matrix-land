import assert from "node:assert/strict";
import test from "node:test";
import { attachmentUploadErrorLabel, prepareChatAttachments } from "./attachments.ts";

const pending = (name, id = name) => ({ id, file: new File(["fixture"], name) });
const stored = (file) => ({ fileName: file.name, objectId: `art_${file.name}`, rawUrl: `/api/workspace-files/${file.name}/raw` });

test("partial upload failures keep all files and reuse completed uploads on retry", async () => {
  const attachments = [pending("good.xlsx"), pending("failed.xlsx")];
  let releaseGood;
  const goodUpload = new Promise((resolve) => { releaseGood = resolve; });
  const attempt = prepareChatAttachments(attachments, "same-user-and-mate", (file) => {
    if (file.name === "failed.xlsx") throw new Error("workspace_attachment_upload_failed");
    return goodUpload;
  });
  releaseGood(stored(attachments[0].file));
  const result = await attempt;
  assert.deepEqual(result.failures, [{ id: "failed.xlsx", fileName: "failed.xlsx", code: "workspace_attachment_upload_failed" }]);
  assert.equal(result.pending.length, 2);
  assert.equal(result.pending[0].uploaded.file.fileName, "good.xlsx");
  assert.equal(result.pending[1].file, attachments[1].file);
  const retried = [];
  const retry = await prepareChatAttachments(result.pending, "same-user-and-mate", async (file) => {
    retried.push(file.name);
    return stored(file);
  });
  assert.deepEqual(retried, ["failed.xlsx"]);
  assert.deepEqual(retry.failures, []);
  assert.deepEqual(retry.files.map((file) => file.fileName), ["good.xlsx", "failed.xlsx"]);
});

test("cached uploads are not reused across user or Mate changes", async () => {
  const attachment = pending("file.xlsx");
  const first = await prepareChatAttachments([attachment], "user-a:mate-a", async (file) => stored(file));
  let uploads = 0;
  await prepareChatAttachments(first.pending, "user-b:mate-a", async (file) => { uploads++; return stored(file); });
  await prepareChatAttachments(first.pending, "user-a:mate-b", async (file) => { uploads++; return stored(file); });
  assert.equal(uploads, 2);
});

test("upload errors identify files and explain recovery in both languages without technical error text", async () => {
  const result = await prepareChatAttachments([pending("工作区.xlsx")], "scope", async () => { throw new TypeError("Failed to fetch"); });
  assert.equal(result.failures[0].code, "type_error");
  assert.match(attachmentUploadErrorLabel(result.failures, false), /文件上传失败：工作区.xlsx/);
  assert.match(attachmentUploadErrorLabel(result.failures, false), /当前对话仍可使用/);
  assert.match(attachmentUploadErrorLabel(result.failures, true), /File upload failed: 工作区.xlsx/);
  assert.doesNotMatch(attachmentUploadErrorLabel(result.failures, true), /type_error|Failed to fetch/);
});
