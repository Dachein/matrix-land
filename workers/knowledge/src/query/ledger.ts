import { safeErrorName } from "../errors.ts";
import { HttpError } from "../http.ts";
import { sha256Hex } from "../objects/content.ts";
import type { Env, KnowledgeServiceRow, Principal } from "../types.ts";
import { isRecord, readString } from "../values.ts";
import type { KnowledgeQueryLedgerContext, KnowledgeServiceQueryAction } from "./types.ts";

// Own query audit records, idempotent step binding and raw-text retention.
export async function beginKnowledgeQueryLedgerStep(
  env: Env,
  principal: Principal,
  service: KnowledgeServiceRow,
  action: KnowledgeServiceQueryAction,
  body: Record<string, unknown>,
  requestId: string
): Promise<KnowledgeQueryLedgerContext> {
  const rawContext = body.queryContext ?? body.query_context;
  const context = isRecord(rawContext) ? rawContext : {};
  const requestedQueryId = readString(context.queryId ?? context.query_id).trim();
  if (requestedQueryId && !/^kquery_[A-Za-z0-9_-]{8,120}$/.test(requestedQueryId)) {
    throw new HttpError(400, "knowledge_query_id_invalid");
  }
  const queryId = requestedQueryId || `kquery_${crypto.randomUUID()}`;
  const clientSessionId = boundedLedgerText(
    context.clientSessionId ?? context.client_session_id,
    "knowledge_client_session_id_invalid",
    240
  );
  const clientTurnId = boundedLedgerText(
    context.clientTurnId ?? context.client_turn_id,
    "knowledge_client_turn_id_invalid",
    240
  );
  const originalQuestion = boundedLedgerText(
    context.originalQuestion ?? context.original_question,
    "knowledge_original_question_invalid",
    4_000
  );
  const originalQuestionHash = originalQuestion
    ? await sha256Hex(new TextEncoder().encode(originalQuestion))
    : "";
  const storeOriginalQuestion = context.storeOriginalQuestion === true
    || context.store_original_question === true;
  const rawQuestionExpiresAt = storeOriginalQuestion && originalQuestion
    ? knowledgeRawQuestionExpiresAt(env)
    : null;

  const existing = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT id, org_id, actor_user_id, original_question_hash
       FROM knowledge_query_sessions
       WHERE id = ?`
    )
    .bind(queryId)
    .first<Record<string, unknown>>();
  if (
    existing
    && (
      readString(existing.org_id) !== principal.orgId
      || readString(existing.actor_user_id) !== principal.sub
    )
  ) {
    throw new HttpError(409, "knowledge_query_owner_mismatch");
  }
  if (
    existing
    && originalQuestionHash
    && readString(existing.original_question_hash)
    && readString(existing.original_question_hash) !== originalQuestionHash
  ) {
    throw new HttpError(409, "knowledge_query_question_mismatch");
  }

  if (!existing) {
    await env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_query_sessions (
           id, org_id, actor_user_id, connection_id, client_id,
           client_session_id, client_turn_id, original_question_hash,
           original_question_text, raw_question_expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        queryId,
        principal.orgId,
        principal.sub,
        principal.connectionId ?? "",
        principal.clientId ?? "",
        clientSessionId,
        clientTurnId,
        originalQuestionHash,
        storeOriginalQuestion ? originalQuestion : "",
        rawQuestionExpiresAt
      )
      .run();
  } else {
    await env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_query_sessions
         SET connection_id = CASE WHEN connection_id = '' THEN ? ELSE connection_id END,
             client_id = CASE WHEN client_id = '' THEN ? ELSE client_id END,
             client_session_id = CASE WHEN client_session_id = '' THEN ? ELSE client_session_id END,
             client_turn_id = CASE WHEN client_turn_id = '' THEN ? ELSE client_turn_id END,
             original_question_hash = CASE WHEN original_question_hash = '' THEN ? ELSE original_question_hash END,
             original_question_text = CASE
               WHEN original_question_text = '' AND ? = 1 THEN ?
               ELSE original_question_text
             END,
             raw_question_expires_at = CASE
               WHEN raw_question_expires_at IS NULL AND ? = 1 THEN ?
               ELSE raw_question_expires_at
             END,
             last_activity_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .bind(
        principal.connectionId ?? "",
        principal.clientId ?? "",
        clientSessionId,
        clientTurnId,
        originalQuestionHash,
        storeOriginalQuestion ? 1 : 0,
        originalQuestion,
        storeOriginalQuestion ? 1 : 0,
        rawQuestionExpiresAt,
        queryId
      )
      .run();
  }

  const parentStepId = boundedLedgerText(
    context.parentStepId ?? context.parent_step_id,
    "knowledge_parent_query_step_id_invalid",
    140
  );
  if (parentStepId) {
    const parent = await env.KNOWLEDGE_DB
      .prepare("SELECT query_id FROM knowledge_query_steps WHERE id = ?")
      .bind(parentStepId)
      .first<{ query_id: string }>();
    if (!parent || parent.query_id !== queryId) {
      throw new HttpError(409, "knowledge_parent_query_step_mismatch");
    }
  }
  const queryStepId = `kstep_${crypto.randomUUID()}`;
  const queryText = knowledgeQueryText(action, body);
  const queryTextHash = queryText
    ? await sha256Hex(new TextEncoder().encode(queryText))
    : "";
  await env.KNOWLEDGE_DB
    .prepare(
      `INSERT INTO knowledge_query_steps (
         id, query_id, parent_step_id, service_id, actor_user_id,
         action, request_id, query_text_hash, source_revision,
         index_generation
       ) VALUES (?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      queryStepId,
      queryId,
      parentStepId,
      service.id,
      principal.sub,
      action,
      requestId,
      queryTextHash,
      service.source_revision,
      service.index_generation
    )
    .run();
  return { queryId, queryStepId, startedAt: Date.now() };
}

export async function completeKnowledgeQueryLedgerStep(
  env: Env,
  ledger: KnowledgeQueryLedgerContext,
  status: "succeeded" | "failed",
  result?: Record<string, unknown>,
  error?: unknown
) {
  const resultCount = Array.isArray(result?.results)
    ? result.results.length
    : Array.isArray(result?.items)
      ? result.items.length
      : result?.file
        ? 1
        : 0;
  const errorCode = error instanceof HttpError
    ? error.code
    : error
      ? safeErrorName(error)
      : "";
  try {
    await env.KNOWLEDGE_DB.batch([
      env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_query_steps
           SET result_count = ?, duration_ms = ?, status = ?, error_code = ?,
               completed_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .bind(
          resultCount,
          Math.max(0, Date.now() - ledger.startedAt),
          status,
          errorCode,
          ledger.queryStepId
        ),
      env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_query_sessions
           SET last_activity_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .bind(ledger.queryId)
    ]);
  } catch (completionError) {
    // Query Ledger completion is observability, not an authorization gate.
    // The start row already exists, so preserve the actual retrieval result
    // and leave the incomplete step visible for operational reconciliation.
    console.error("knowledge_query_ledger_completion_failed", {
      error: safeErrorName(completionError),
      queryId: ledger.queryId,
      queryStepId: ledger.queryStepId,
      status
    });
  }
}

function knowledgeQueryText(action: KnowledgeServiceQueryAction, body: Record<string, unknown>) {
  if (action === "search") return readString(body.query ?? body.q).trim();
  if (action === "grep") return readString(body.pattern ?? body.query ?? body.q).trim();
  if (action === "glob") return readString(body.pattern ?? body.glob).trim();
  if (action === "tree") return readString(body.relativePath ?? body.path).trim();
  return readString(body.relativePath ?? body.path ?? body.objectId).trim();
}

function boundedLedgerText(value: unknown, errorCode: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    throw new HttpError(400, errorCode);
  }
  const text = value.trim();
  if (text.length > maxLength || /[\u0000-\u001f]/.test(text)) {
    throw new HttpError(400, errorCode);
  }
  return text;
}

function knowledgeRawQuestionExpiresAt(env: Env) {
  const parsed = Number(env.KNOWLEDGE_QUERY_RAW_RETENTION_DAYS);
  const retentionDays = Number.isFinite(parsed)
    ? Math.max(1, Math.min(90, Math.trunc(parsed)))
    : 30;
  return new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1_000).toISOString();
}

async function cleanupExpiredKnowledgeQueryText(env: Env) {
  await env.KNOWLEDGE_DB
    .prepare(
      `UPDATE knowledge_query_sessions
       SET original_question_text = '', raw_question_expires_at = NULL
       WHERE original_question_text != ''
         AND raw_question_expires_at IS NOT NULL
         AND datetime(raw_question_expires_at) <= CURRENT_TIMESTAMP`
    )
    .run();
}

export async function cleanupExpiredKnowledgeQueryData(env: Env) {
  await cleanupExpiredKnowledgeQueryText(env);
  await cleanupExpiredKnowledgeQueryLedger(env);
}

async function cleanupExpiredKnowledgeQueryLedger(env: Env) {
  const parsed = Number(env.KNOWLEDGE_QUERY_LEDGER_RETENTION_DAYS);
  const retentionDays = Number.isFinite(parsed)
    ? Math.max(30, Math.min(730, Math.trunc(parsed)))
    : 180;
  await env.KNOWLEDGE_DB
    .prepare(
      `DELETE FROM knowledge_query_sessions
       WHERE datetime(last_activity_at) <= datetime('now', ?)`
    )
    .bind(`-${retentionDays} days`)
    .run();
}
