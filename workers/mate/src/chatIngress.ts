import { RuntimeHttpError, type RuntimeMode } from "./types.ts";
import { encodeIdentityPathSegment } from "../../../src/shared/identityPath.ts";

export type ChatIngressClaimInput = {
  agentInstanceName: string;
  clientMessageId: string;
  conversationId: string;
  environmentDigest: string;
  messageDigest: string;
  mode: RuntimeMode;
  releaseId: string;
  taskId: string;
  mateId: string;
  userId: string;
};

export type ChatIngressClaim = ChatIngressClaimInput & {
  createdAt: string;
  disposition: "claimed" | "replayed";
  updatedAt: string;
};

export type ChatIngressDeps = {
  now?: () => Date;
};

type ChatIngressRow = {
  agentInstanceName: string;
  clientMessageId: string;
  conversationId: string;
  createdAt: string;
  environmentDigest: string;
  messageDigest: string;
  mode: RuntimeMode;
  releaseId: string;
  taskId: string;
  mateId: string;
  updatedAt: string;
  userId: string;
};

type TaskProjectionRow = {
  conversationId: string | null;
  releaseId: string;
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export async function claimChatIngress(
  db: D1Database,
  input: ChatIngressClaimInput,
  deps: ChatIngressDeps = {}
): Promise<ChatIngressClaim> {
  const claim = normalizeClaim(input);
  const now = normalizedNow(deps);
  const existing = await readChatIngress(db, claim);
  if (existing) return replayOrConflict(db, existing, claim, now);

  await assertTaskProjection(db, claim);
  const result = await db.prepare(`
    INSERT INTO mate_chat_ingress (
      mate_id, user_id, runtime_mode, conversation_id, client_message_id,
      release_id, task_id, agent_instance_name, message_digest,
      environment_digest, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (
      mate_id, user_id, runtime_mode, conversation_id, client_message_id
    ) DO NOTHING
  `).bind(
    claim.mateId,
    claim.userId,
    claim.mode,
    claim.conversationId,
    claim.clientMessageId,
    claim.releaseId,
    claim.taskId,
    claim.agentInstanceName,
    claim.messageDigest,
    claim.environmentDigest,
    now,
    now
  ).run();

  const stored = await readChatIngress(db, claim);
  if (!stored) throw new RuntimeHttpError(500, "chat_ingress_claim_failed");
  assertSameProjection(stored, claim);
  if (Number(result.meta.changes ?? 0) === 0) {
    return replayOrConflict(db, stored, claim, now);
  }
  await touchConversation(db, claim, now);
  return claimFromRow(stored, "claimed");
}

async function replayOrConflict(
  db: D1Database,
  existing: ChatIngressRow,
  claim: ChatIngressClaimInput,
  now: string
) {
  assertSameProjection(existing, claim);
  await db.batch([
    db.prepare(`
      UPDATE mate_chat_ingress
      SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = ?
        AND conversation_id = ? AND client_message_id = ?
    `).bind(
      now,
      now,
      claim.mateId,
      claim.userId,
      claim.mode,
      claim.conversationId,
      claim.clientMessageId
    ),
    conversationTouchStatement(db, claim, now)
  ]);
  const replayed = await readChatIngress(db, claim);
  if (!replayed) throw new RuntimeHttpError(500, "chat_ingress_claim_failed");
  return claimFromRow(replayed, "replayed");
}

async function assertTaskProjection(db: D1Database, claim: ChatIngressClaimInput) {
  const row = await db.prepare(`
    SELECT conversation_id AS conversationId, release_id AS releaseId
    FROM mate_tasks
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ?
    LIMIT 1
  `).bind(
    claim.mateId,
    claim.userId,
    claim.mode,
    claim.taskId
  ).first<TaskProjectionRow>();
  if (!row) throw new RuntimeHttpError(404, "chat_ingress_task_not_found");
  const conflictingFields = [
    ...(row.conversationId !== claim.conversationId ? ["conversationId"] : []),
    ...(row.releaseId !== claim.releaseId ? ["releaseId"] : [])
  ];
  if (conflictingFields.length) {
    throw new RuntimeHttpError(409, "chat_ingress_task_projection_conflict", { conflictingFields });
  }
}

function assertSameProjection(existing: ChatIngressRow, claim: ChatIngressClaimInput) {
  const conflictingFields = [
    ...(existing.releaseId !== claim.releaseId ? ["releaseId"] : []),
    ...(existing.taskId !== claim.taskId ? ["taskId"] : []),
    ...(existing.agentInstanceName !== claim.agentInstanceName ? ["agentInstanceName"] : []),
    ...(existing.messageDigest !== claim.messageDigest ? ["messageDigest"] : []),
    ...(existing.environmentDigest !== claim.environmentDigest ? ["environmentDigest"] : [])
  ];
  if (conflictingFields.length) {
    throw new RuntimeHttpError(409, "chat_ingress_claim_conflict", { conflictingFields });
  }
}

async function readChatIngress(db: D1Database, claim: ChatIngressClaimInput) {
  return db.prepare(`
    SELECT mate_id AS mateId, user_id AS userId, runtime_mode AS mode,
           conversation_id AS conversationId, client_message_id AS clientMessageId,
           release_id AS releaseId, task_id AS taskId,
           agent_instance_name AS agentInstanceName,
           message_digest AS messageDigest,
           environment_digest AS environmentDigest,
           created_at AS createdAt, updated_at AS updatedAt
    FROM mate_chat_ingress
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ?
      AND conversation_id = ? AND client_message_id = ?
    LIMIT 1
  `).bind(
    claim.mateId,
    claim.userId,
    claim.mode,
    claim.conversationId,
    claim.clientMessageId
  ).first<ChatIngressRow>();
}

async function touchConversation(db: D1Database, claim: ChatIngressClaimInput, now: string) {
  await conversationTouchStatement(db, claim, now).run();
}

function conversationTouchStatement(db: D1Database, claim: ChatIngressClaimInput, now: string) {
  return db.prepare(`
    UPDATE mate_conversations
    SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ? AND id = ?
  `).bind(
    now,
    now,
    claim.mateId,
    claim.userId,
    claim.mode,
    claim.conversationId
  );
}

function claimFromRow(row: ChatIngressRow, disposition: ChatIngressClaim["disposition"]): ChatIngressClaim {
  return { ...row, disposition };
}

function normalizeClaim(input: ChatIngressClaimInput): ChatIngressClaimInput {
  const mode = input.mode;
  if (mode !== "live" && mode !== "preview") throw new RuntimeHttpError(422, "chat_ingress_mode_invalid");
  return {
    agentInstanceName: requiredIdentifier(input.agentInstanceName, "chat_ingress_agent_instance_name_invalid"),
    clientMessageId: requiredIdentifier(input.clientMessageId, "chat_ingress_client_message_id_invalid"),
    conversationId: requiredIdentifier(input.conversationId, "chat_ingress_conversation_id_invalid"),
    environmentDigest: requiredSha256Digest(input.environmentDigest, "chat_ingress_environment_digest_invalid"),
    messageDigest: requiredSha256Digest(input.messageDigest, "chat_ingress_message_digest_invalid"),
    mode,
    releaseId: requiredIdentifier(input.releaseId, "chat_ingress_release_id_invalid"),
    taskId: requiredIdentifier(input.taskId, "chat_ingress_task_id_invalid"),
    mateId: requiredIdentifier(input.mateId, "chat_ingress_mate_id_invalid"),
    userId: requiredUserId(input.userId)
  };
}

function requiredUserId(value: string) {
  try {
    encodeIdentityPathSegment(value);
    return value;
  } catch {
    throw new RuntimeHttpError(422, "chat_ingress_user_id_invalid");
  }
}

function requiredIdentifier(value: unknown, code: string) {
  const identifier = typeof value === "string" ? value.trim() : "";
  if (!IDENTIFIER_PATTERN.test(identifier)) throw new RuntimeHttpError(422, code);
  return identifier;
}

function requiredSha256Digest(value: unknown, code: string) {
  const digest = typeof value === "string" ? value : "";
  if (!SHA256_DIGEST_PATTERN.test(digest)) throw new RuntimeHttpError(422, code);
  return digest;
}

function normalizedNow(deps: ChatIngressDeps) {
  const date = deps.now?.() ?? new Date();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new RuntimeHttpError(500, "chat_ingress_clock_invalid");
  }
  return date.toISOString();
}
