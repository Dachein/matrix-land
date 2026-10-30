import { mateChatInstanceName } from "./chatAddress.ts";
import { readConversation } from "./storage.ts";
import { RuntimeHttpError, type RuntimeEnv, type RuntimeMode, type RuntimePrincipal } from "./types.ts";

type AgentInstanceRow = { agentInstanceName: string };
type DestroyableAgentStub = DurableObjectStub & { _cf_scheduleDestroy(): Promise<void> };

/**
 * Deletes one caller-owned conversation. The Agent DO is scheduled for durable
 * destruction before its D1 directory projection is removed so a failed
 * destroy request never strands an undiscoverable transcript.
 */
export async function deleteConversation(
  env: RuntimeEnv,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  conversationId: string,
  currentReleaseId: string
) {
  await readConversation(env.RUNTIME_DB, mateId, principal.userId, mode, conversationId);
  if (!env.MATE_CHAT_AGENT) {
    throw new RuntimeHttpError(503, "mate_chat_agent_not_configured");
  }
  const stored = await env.RUNTIME_DB.prepare(`
    SELECT DISTINCT agent_instance_name AS agentInstanceName
    FROM mate_conversation_turns
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND conversation_id = ?
    UNION
    SELECT DISTINCT agent_instance_name AS agentInstanceName
    FROM mate_chat_ingress
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND conversation_id = ?
  `).bind(
    mateId, principal.userId, mode, conversationId,
    mateId, principal.userId, mode, conversationId
  ).all<AgentInstanceRow>();
  const names = new Set((stored.results ?? []).map((row) => row.agentInstanceName));
  names.add(await mateChatInstanceName({
    conversationId,
    mode,
    ...(mode === "preview" ? { releaseId: currentReleaseId } : {}),
    mateId,
    userId: principal.userId
  }));

  for (const instanceName of names) {
    const id = env.MATE_CHAT_AGENT.idFromName(instanceName);
    const agent = env.MATE_CHAT_AGENT.get(id, { locationHint: "apac" }) as DestroyableAgentStub;
    await agent._cf_scheduleDestroy();
  }

  const result = await env.RUNTIME_DB.prepare(`
    DELETE FROM mate_conversations
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ?
  `).bind(mateId, principal.userId, mode, conversationId).run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new RuntimeHttpError(409, "conversation_delete_conflict");
  }
  return { deleted: true, id: conversationId, scheduledAgentInstances: names.size };
}
