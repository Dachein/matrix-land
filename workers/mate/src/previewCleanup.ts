import { mateChatInstanceName } from "./chatAddress.ts";
import { RuntimeHttpError, type RuntimeEnv, type RuntimePrincipal } from "./types.ts";

type ConversationRow = {
  conversationId: string;
};

type AgentInstanceRow = {
  agentInstanceName: string;
};

type CountRow = {
  count: number;
};

type DestroyableAgentStub = DurableObjectStub & {
  _cf_scheduleDestroy(): Promise<void>;
};

/**
 * Clears only the current owner's Preview namespace for one Mate. Live
 * conversations and every other user's data remain outside this query.
 *
 * Agent DO destruction is durably scheduled before the D1 directory is
 * removed. If D1 cleanup fails, a retry can still remove the visible
 * projections; the inverse order could strand transcript-bearing DOs after
 * their directory metadata had already disappeared.
 */
export async function clearOwnerPreviewData(
  env: RuntimeEnv,
  mateId: string,
  principal: RuntimePrincipal,
  currentReleaseId: string
) {
  if (principal.callerKind !== "user" || principal.testGrant?.mateId !== mateId) {
    throw new RuntimeHttpError(403, "mate_owner_test_grant_required");
  }
  if (!env.MATE_CHAT_AGENT) {
    throw new RuntimeHttpError(503, "mate_chat_agent_not_configured");
  }

  const [conversationResult, storedAgentResult, conversationCountRow, sessionCountRow] = await Promise.all([
    env.RUNTIME_DB.prepare(`
      SELECT id AS conversationId
      FROM mate_conversations
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = 'preview'
    `).bind(mateId, principal.userId).all<ConversationRow>(),
    env.RUNTIME_DB.prepare(`
      SELECT DISTINCT agent_instance_name AS agentInstanceName
      FROM mate_conversation_turns
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = 'preview'
      UNION
      SELECT DISTINCT agent_instance_name AS agentInstanceName
      FROM mate_chat_ingress
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = 'preview'
    `).bind(mateId, principal.userId, mateId, principal.userId).all<AgentInstanceRow>(),
    env.RUNTIME_DB.prepare(`
      SELECT COUNT(*) AS count
      FROM mate_conversations
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = 'preview'
    `).bind(mateId, principal.userId).first<CountRow>(),
    env.RUNTIME_DB.prepare(`
      SELECT COUNT(*) AS count
      FROM mate_sessions
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = 'preview'
    `).bind(mateId, principal.userId).first<CountRow>()
  ]);

  const conversationIds = (conversationResult.results ?? []).map((row) => row.conversationId);
  const agentInstanceNames = new Set(
    (storedAgentResult.results ?? []).map((row) => row.agentInstanceName)
  );
  for (const conversationId of conversationIds) {
    agentInstanceNames.add(await mateChatInstanceName({
      conversationId,
      mode: "preview",
      releaseId: currentReleaseId,
      mateId,
      userId: principal.userId
    }));
  }

  for (const instanceName of agentInstanceNames) {
    const id = env.MATE_CHAT_AGENT.idFromName(instanceName);
    const agent = env.MATE_CHAT_AGENT.get(id, { locationHint: "apac" }) as DestroyableAgentStub;
    await agent._cf_scheduleDestroy();
  }

  await env.RUNTIME_DB.batch([
    env.RUNTIME_DB.prepare(`DELETE FROM mate_work_threads WHERE mate_id=? AND user_id=? AND runtime_mode='preview'`).bind(mateId,principal.userId),
    env.RUNTIME_DB.prepare(`
      DELETE FROM mate_conversations
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = 'preview'
    `).bind(mateId, principal.userId),
    env.RUNTIME_DB.prepare(`
      DELETE FROM mate_sessions
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = 'preview'
    `).bind(mateId, principal.userId)
  ]);

  return {
    deletedConversations: Number(conversationCountRow?.count ?? 0),
    deletedSessions: Number(sessionCountRow?.count ?? 0),
    scheduledAgentInstances: agentInstanceNames.size
  };
}
