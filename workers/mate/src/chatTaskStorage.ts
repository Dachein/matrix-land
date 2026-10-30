import type { WorkspaceAcceptedMateEnvironment } from "../../../sdk/mate/environment.ts";
import { claimChatIngress, type ChatIngressClaim } from "./chatIngress.ts";
import { RuntimeHttpError, type RuntimeMode } from "./types.ts";

export type CreateChatTaskProjectionInput = {
  agentInstanceName: string;
  clientMessageId: string;
  conversationId: string;
  environment: WorkspaceAcceptedMateEnvironment;
  messageDigest: string;
  mode: RuntimeMode;
  releaseId: string;
  mateId: string;
  userId: string;
};

export type ChatTaskProjection = {
  disposition: ChatIngressClaim["disposition"];
  sessionId: string;
  status: string;
  taskId: string;
};

type TaskProjectionRow = {
  contextJson: string;
  conversationId: string | null;
  instruction: string;
  releaseId: string;
  sessionId: string;
  status: string;
};

/**
 * Creates the D1 Session/Task projection for one Agent DO user message. The
 * model-visible text remains exclusively in AIChatAgent SQLite; D1 stores only
 * a stable message reference and cryptographic digest.
 */
export async function createChatTaskProjection(
  db: D1Database,
  input: CreateChatTaskProjectionInput
): Promise<ChatTaskProjection> {
  const ids = await chatProjectionIds(input);
  const instructionReference = `agent-do-message:${input.clientMessageId}:${input.messageDigest}`;
  const existing = await readProjection(db, input, ids.taskId);
  if (!existing) {
    const now = new Date().toISOString();
    const sessionKind = input.mode === "preview" ? "owner_test" : "conversation_turn";
    await db.batch([
      db.prepare(`
        INSERT INTO mate_sessions (
          mate_id, user_id, runtime_mode, id, kind, channel,
          conversation_id, release_id, context_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'sdk', ?, ?, ?, 'open', ?)
        ON CONFLICT (mate_id, user_id, runtime_mode, id) DO NOTHING
      `).bind(
        input.mateId,
        input.userId,
        input.mode,
        ids.sessionId,
        sessionKind,
        input.conversationId,
        input.releaseId,
        JSON.stringify(input.environment),
        now
      ),
      db.prepare(`
        INSERT INTO mate_tasks (
          mate_id, user_id, runtime_mode, id, session_id, conversation_id,
          parent_task_id, root_task_id, release_id, channel, status,
          instruction, context_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'sdk', 'queued', ?, ?, ?, ?)
        ON CONFLICT (mate_id, user_id, runtime_mode, id) DO NOTHING
      `).bind(
        input.mateId,
        input.userId,
        input.mode,
        ids.taskId,
        ids.sessionId,
        input.conversationId,
        ids.taskId,
        input.releaseId,
        instructionReference,
        JSON.stringify(input.environment),
        now,
        now
      ),
      db.prepare(`
        INSERT INTO mate_task_events (
          mate_id, user_id, runtime_mode, task_id, run_id,
          sequence, type, payload_json, created_at
        ) VALUES (?, ?, ?, ?, NULL, 1, 'mate.task.created', ?, ?)
        ON CONFLICT (mate_id, user_id, runtime_mode, task_id, sequence) DO NOTHING
      `).bind(input.mateId, input.userId, input.mode, ids.taskId, JSON.stringify({
        agentInstanceName: input.agentInstanceName,
        channel: "sdk",
        clientMessageId: input.clientMessageId,
        environmentDigest: input.environment.digest,
        messageDigest: input.messageDigest,
        mode: input.mode,
        releaseId: input.releaseId,
        sessionId: ids.sessionId
      }), now)
    ]);
  }

  const stored = await readProjection(db, input, ids.taskId);
  if (!stored) throw new RuntimeHttpError(500, "mate_chat_task_projection_failed");
  assertProjection(stored, input, ids.sessionId, instructionReference);
  const ingress = await claimChatIngress(db, {
    agentInstanceName: input.agentInstanceName,
    clientMessageId: input.clientMessageId,
    conversationId: input.conversationId,
    environmentDigest: input.environment.digest,
    messageDigest: input.messageDigest,
    mode: input.mode,
    releaseId: input.releaseId,
    taskId: ids.taskId,
    mateId: input.mateId,
    userId: input.userId
  });
  return {
    disposition: ingress.disposition,
    sessionId: ids.sessionId,
    status: stored.status,
    taskId: ids.taskId
  };
}

export async function digestChatMessage(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `sha256:${hex(digest)}`;
}

export async function chatProjectionIds(input: Pick<
  CreateChatTaskProjectionInput,
  "clientMessageId" | "conversationId" | "mode" | "releaseId" | "mateId" | "userId"
>) {
  const coordinate = [
    input.mateId,
    input.userId,
    input.mode,
    input.conversationId,
    ...(input.mode === "preview" ? [input.releaseId] : []),
    input.clientMessageId
  ].join("\u0000");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(coordinate)));
  const suffix = hex(digest).slice(0, 48);
  return { sessionId: `session_chat_${suffix}`, taskId: `task_chat_${suffix}` };
}

async function readProjection(db: D1Database, input: CreateChatTaskProjectionInput, taskId: string) {
  return db.prepare(`
    SELECT session_id AS sessionId, conversation_id AS conversationId,
           release_id AS releaseId, instruction, context_json AS contextJson, status
    FROM mate_tasks
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ?
    LIMIT 1
  `).bind(input.mateId, input.userId, input.mode, taskId).first<TaskProjectionRow>();
}

function assertProjection(
  row: TaskProjectionRow,
  input: CreateChatTaskProjectionInput,
  sessionId: string,
  instructionReference: string
) {
  const context = parseRecord(row.contextJson);
  const conflicts = [
    ...(row.sessionId !== sessionId ? ["sessionId"] : []),
    ...(row.conversationId !== input.conversationId ? ["conversationId"] : []),
    ...(row.releaseId !== input.releaseId ? ["releaseId"] : []),
    ...(row.instruction !== instructionReference ? ["messageDigest"] : []),
    ...(context.digest !== input.environment.digest ? ["environmentDigest"] : [])
  ];
  if (conflicts.length) {
    throw new RuntimeHttpError(409, "mate_chat_task_projection_conflict", { conflictingFields: conflicts });
  }
}

function parseRecord(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function hex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
