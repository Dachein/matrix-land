import assert from "node:assert/strict";
import { it } from "node:test";
import { pendingRuntimeApprovals } from "./mateApproval.js";

it("shows every pending operation type only in its originating conversation", () => {
  const approvals = [
    { id: "forum", status: "pending", releaseId: "r1", conversationId: "c1", operation: { type: "workspace_pass_mcp_tool_call" } },
    { id: "edit", status: "pending", releaseId: "r1", conversationId: "c1", operation: { type: "workspace_knowledge_maintenance" } },
    { id: "other", status: "pending", releaseId: "r1", conversationId: "c2", operation: { type: "app_mcp_tool_call" } },
    { id: "done", status: "consumed", releaseId: "r1", conversationId: "c1", operation: { type: "workspace_pass_mcp_tool_call" } },
    { id: "old", status: "pending", releaseId: "r0", conversationId: "c1", operation: { type: "mate_self_definition_update" } }
  ];
  assert.deepEqual(pendingRuntimeApprovals(approvals, { conversationId: "c1", releaseId: "r1" }).map((item) => item.id), ["forum", "edit"]);
  assert.deepEqual(pendingRuntimeApprovals(approvals, { releaseId: "r1" }).map((item) => item.id), ["forum", "edit", "other"]);
  assert.deepEqual(pendingRuntimeApprovals(approvals, { conversationId: undefined, releaseId: "r1" }).map((item) => item.id), ["forum", "edit", "other"]);
  assert.deepEqual(pendingRuntimeApprovals(approvals, { conversationId: "", releaseId: "r1" }), []);
});
