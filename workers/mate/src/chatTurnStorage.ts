import type { WorkspaceAcceptedMateEnvironment } from "../../../sdk/mate/environment.ts";
import { mateConversationTitle } from "../../../src/shared/mateConversation.ts";
import { RuntimeHttpError, type RuntimeMode } from "./types.ts";

export type CreateChatTurnProjectionInput = {
  agentInstanceName: string;
  clientMessageId: string;
  conversationTitle: string;
  conversationId: string;
  environment: WorkspaceAcceptedMateEnvironment;
  messageDigest: string;
  mode: RuntimeMode;
  releaseId: string;
  mateId: string;
  turnId: string;
  userId: string;
};

export type ChatTurnProjection = {
  disposition: "claimed" | "replayed";
  errorCode?: string;
  status: "accepted" | "running" | "completed" | "failed" | "cancelled";
  turnId: string;
};

type ChatTurnRow = {
  agentInstanceName: string;
  assistantMessageId: string | null;
  clientMessageId: string;
  conversationId: string;
  environmentDigest: string;
  errorCode: string | null;
  messageDigest: string;
  releaseId: string;
  responseDigest: string | null;
  status: ChatTurnProjection["status"];
  turnId: string;
};

/** Claims one metadata-only D1 projection for a DO-owned conversation turn. */
export async function createChatTurnProjection(
  db: D1Database,
  input: CreateChatTurnProjectionInput
): Promise<ChatTurnProjection> {
  const existing = await readChatTurnProjection(db, input, input.turnId);
  if (existing) {
    assertSameTurn(existing, input);
    await touchConversation(db, input);
    return {
      disposition: "replayed",
      ...(existing.errorCode ? { errorCode: existing.errorCode } : {}),
      status: existing.status,
      turnId: existing.turnId
    };
  }
  const now = new Date().toISOString();
  const result = await db.prepare(`
    INSERT INTO mate_conversation_turns (
      mate_id, user_id, runtime_mode, conversation_id, client_message_id,
      turn_id, release_id, agent_instance_name, message_digest,
      environment_digest, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)
    ON CONFLICT (
      mate_id, user_id, runtime_mode, conversation_id, client_message_id
    ) DO NOTHING
  `).bind(
    input.mateId,
    input.userId,
    input.mode,
    input.conversationId,
    input.clientMessageId,
    input.turnId,
    input.releaseId,
    input.agentInstanceName,
    input.messageDigest,
    input.environment.digest,
    now,
    now
  ).run();
  const stored = await readChatTurnByClientMessage(db, input);
  if (!stored) throw new RuntimeHttpError(500, "mate_chat_turn_projection_failed");
  assertSameTurn(stored, input);
  await touchConversation(db, input, now);
  return {
    disposition: Number(result.meta.changes ?? 0) > 0 ? "claimed" : "replayed",
    ...(stored.errorCode ? { errorCode: stored.errorCode } : {}),
    status: stored.status,
    turnId: stored.turnId
  };
}

export async function startChatTurnProjection(
  db: D1Database,
  input: Pick<CreateChatTurnProjectionInput, "mode" | "mateId" | "turnId" | "userId">
) {
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE mate_conversation_turns
    SET status = 'running', assistant_message_id = NULL, response_digest = NULL,
        error_code = NULL, completed_at = NULL, updated_at = ?
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND turn_id = ?
      AND (status = 'accepted' OR (status = 'cancelled' AND error_code IS NULL))
  `).bind(now, input.mateId, input.userId, input.mode, input.turnId).run();
  const row = await readStatus(db, input);
  if (!row) throw new RuntimeHttpError(404, "mate_chat_turn_not_found");
  if (row.status !== "running") {
    throw new RuntimeHttpError(409, "mate_chat_turn_not_executable", { turnStatus: row.status });
  }
}

export async function concludeChatTurnProjection(
  db: D1Database,
  input: Pick<CreateChatTurnProjectionInput, "mode" | "mateId" | "turnId" | "userId"> & {
    assistantMessageId?: string;
    errorCode?: string;
    outcome: "cancelled" | "completed" | "failed";
    responseDigest?: string;
  }
) {
  const existing = await readStatus(db, input);
  if (!existing) throw new RuntimeHttpError(404, "mate_chat_turn_not_found");
  if (["completed", "failed", "cancelled"].includes(existing.status)) {
    if (
      existing.status === input.outcome
      && existing.assistantMessageId === (input.assistantMessageId ?? null)
      && existing.responseDigest === (input.responseDigest ?? null)
      && existing.errorCode === (input.errorCode ?? null)
    ) return;
    throw new RuntimeHttpError(409, "mate_chat_turn_conclusion_mismatch");
  }
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE mate_conversation_turns
    SET status = ?, assistant_message_id = ?, response_digest = ?, error_code = ?,
        completed_at = ?, updated_at = ?
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND turn_id = ?
      AND status IN ('accepted', 'running')
  `).bind(
    input.outcome,
    input.assistantMessageId ?? null,
    input.responseDigest ?? null,
    input.errorCode?.slice(0, 160) ?? null,
    now,
    now,
    input.mateId,
    input.userId,
    input.mode,
    input.turnId
  ).run();
}

async function readChatTurnProjection(db: D1Database, input: CreateChatTurnProjectionInput, turnId: string) {
  return db.prepare(`
    SELECT conversation_id AS conversationId, client_message_id AS clientMessageId,
           turn_id AS turnId, release_id AS releaseId,
           agent_instance_name AS agentInstanceName,
           message_digest AS messageDigest, environment_digest AS environmentDigest,
           status, assistant_message_id AS assistantMessageId,
           response_digest AS responseDigest, error_code AS errorCode
    FROM mate_conversation_turns
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND turn_id = ?
    LIMIT 1
  `).bind(input.mateId, input.userId, input.mode, turnId).first<ChatTurnRow>();
}

async function readChatTurnByClientMessage(db: D1Database, input: CreateChatTurnProjectionInput) {
  return db.prepare(`
    SELECT conversation_id AS conversationId, client_message_id AS clientMessageId,
           turn_id AS turnId, release_id AS releaseId,
           agent_instance_name AS agentInstanceName,
           message_digest AS messageDigest, environment_digest AS environmentDigest,
           status, assistant_message_id AS assistantMessageId,
           response_digest AS responseDigest, error_code AS errorCode
    FROM mate_conversation_turns
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ?
      AND conversation_id = ? AND client_message_id = ?
    LIMIT 1
  `).bind(
    input.mateId,
    input.userId,
    input.mode,
    input.conversationId,
    input.clientMessageId
  ).first<ChatTurnRow>();
}

async function readStatus(
  db: D1Database,
  input: Pick<CreateChatTurnProjectionInput, "mode" | "mateId" | "turnId" | "userId">
) {
  return db.prepare(`
    SELECT status, assistant_message_id AS assistantMessageId,
           response_digest AS responseDigest, error_code AS errorCode
    FROM mate_conversation_turns
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND turn_id = ?
    LIMIT 1
  `).bind(input.mateId, input.userId, input.mode, input.turnId).first<Pick<
    ChatTurnRow,
    "assistantMessageId" | "errorCode" | "responseDigest" | "status"
  >>();
}

function assertSameTurn(row: ChatTurnRow, input: CreateChatTurnProjectionInput) {
  const conflictingFields = [
    ...(row.turnId !== input.turnId ? ["turnId"] : []),
    ...(row.conversationId !== input.conversationId ? ["conversationId"] : []),
    ...(row.clientMessageId !== input.clientMessageId ? ["clientMessageId"] : []),
    ...(row.releaseId !== input.releaseId ? ["releaseId"] : []),
    ...(row.agentInstanceName !== input.agentInstanceName ? ["agentInstanceName"] : []),
    ...(row.messageDigest !== input.messageDigest ? ["messageDigest"] : []),
    ...(row.environmentDigest !== input.environment.digest ? ["environmentDigest"] : [])
  ];
  if (conflictingFields.length) {
    throw new RuntimeHttpError(409, "mate_chat_turn_projection_conflict", { conflictingFields });
  }
}

async function touchConversation(db: D1Database, input: CreateChatTurnProjectionInput, at = new Date().toISOString()) {
  const title = conversationTitle(input.conversationTitle);
  await db.prepare(`
    UPDATE mate_conversations
    SET title = CASE WHEN TRIM(title) = '' AND ? != '' THEN ? ELSE title END,
        updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ?
  `).bind(
    title,
    title,
    at,
    at,
    input.mateId,
    input.userId,
    input.mode,
    input.conversationId
  ).run();
}

function conversationTitle(value: unknown) {
  return mateConversationTitle({ maxLength: 72, text: typeof value === "string" ? value : "" });
}
