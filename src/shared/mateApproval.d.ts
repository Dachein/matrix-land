export type ApprovalScopeItem = {
  conversationId?: string;
  releaseId?: string;
  status: string;
};

export function pendingRuntimeApprovals<T extends ApprovalScopeItem>(
  approvals: T[],
  scope: { conversationId?: string; releaseId?: string }
): T[];
