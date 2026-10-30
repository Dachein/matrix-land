import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalCardStatus, approvalPresentation, mergeApprovalStates } from "../../../../src/shared/mateApprovalPresentation.ts";
const item = (status, task) => ({ id: "a", status, task, expiresAt: "2099-01-01", releaseId: "r", operation: { type: "workspace_knowledge_maintenance", toolName: "knowledge_library_write", arguments: { action: "edit", operation: "replace_text", fileName: "policy.md", oldText: "old", newText: "new", expectedOccurrences: 1 } } });
test("approval acceptance alone never claims the write succeeded", () => {
  assert.equal(approvalCardStatus(item("consumed")), "executing");
  assert.equal(approvalCardStatus(item("consumed", {status:"failed"})), "failed");
  assert.equal(approvalCardStatus(item("consumed", {status:"completed"})), "completed");
});
test("lagging reads cannot restore pending controls or regress terminal execution", () => {
  const completed = item("consumed", {id:"t", status:"completed"});
  assert.equal(mergeApprovalStates([completed], [item("pending")])[0].status, "consumed");
  assert.equal(mergeApprovalStates([completed], [item("consumed", {id:"t",status:"running"})])[0].task.status, "completed");
});
test("the mobile preview shows stored operation changes with their exact scope", () => {
  const result = approvalPresentation(item("pending"), (zh) => zh);
  assert.deepEqual(result.diff.map((line) => line.kind), ["removed", "added"]);
  assert.equal(result.preview, "new");
  assert.match(result.title, /policy.md/);
  assert.match(result.note, /1 处/);
});
