/** State from authenticated Runtime reads/decisions, separate from historical tool output. */
export type RuntimeApprovalState = {
  id: string;
  taskId?: string;
  status: string;
  expiresAt?: string;
  task?: { id?: string; status?: string; conclusion?: { summary?: string; failures?: Array<{ code?: string; upstreamStatus?: number; upstreamCode?: string; requestId?: string; causeRequestId?: string }> } };
};

export function approvalDisplayState(approval: RuntimeApprovalState) {
  if (approval.status === "denied") return { status: "cancelled" as const, text: "未获批准，已取消" };
  if (approval.status === "expired" || (approval.status === "pending" && Date.parse(approval.expiresAt || "") <= Date.now())) {
    return { status: "cancelled" as const, text: "审批已过期，未执行" };
  }
  if (approval.status === "pending") return { status: "waiting" as const, text: "提案已生成，等待审核" };
  // Approval/consumption alone is never proof that the external write succeeded.
  if (approval.task?.status === "completed") return { status: "completed" as const, text: "审核通过，执行成功" };
  if (approval.task?.status === "failed") return { status: "failed" as const, text: "审核通过，执行失败" };
  if (approval.task?.status === "cancelled") return { status: "cancelled" as const, text: "任务已取消" };
  return { status: "waiting" as const, text: "审核通过，等待执行结果" };
}
