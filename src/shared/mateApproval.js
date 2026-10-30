/** Conversation cards show only approvals created by that conversation; the task view shows every pending approval. */
export function pendingRuntimeApprovals(approvals, scope) {
  const scopedToConversation = scope.conversationId !== undefined;
  return approvals.filter((approval) => approval.status === "pending"
    && (!scope.releaseId || approval.releaseId === scope.releaseId)
    && (!scopedToConversation || (Boolean(scope.conversationId) && approval.conversationId === scope.conversationId)));
}
