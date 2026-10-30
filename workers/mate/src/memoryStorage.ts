import { RuntimeHttpError, type RuntimeMode, type RuntimePrincipal } from "./types.ts";

export type MemoryScopeKind = "conversation" | "email_thread" | "task_root";
export type MemoryEntryKind = "user_message" | "assistant_message" | "tool_call" | "tool_result" | "task_conclusion" | "system_event";

export type RuntimeMemoryScope = {
  id: string;
  kind: MemoryScopeKind;
};

export type RuntimeMemoryEntry = {
  createdAt: string;
  entryKind: MemoryEntryKind;
  estimatedTokens: number;
  id: string;
  parentEntryId?: string;
  payload: unknown;
  payloadDigest: string;
  sequence: number;
};

export type RuntimeMemoryCompaction = {
  createdAt: string;
  fromSequence: number;
  id: string;
  modelId: string;
  policyVersion: string;
  previousCompactionId?: string;
  releaseId: string;
  sourceDigest: string;
  sourceTokenEstimate: number;
  status: "active" | "superseded" | "invalid";
  summary: Record<string, unknown>;
  summaryDigest: string;
  summaryTokenEstimate: number;
  toSequence: number;
};

const ENTRY_KINDS = new Set<MemoryEntryKind>([
  "user_message", "assistant_message", "tool_call", "tool_result", "task_conclusion", "system_event"
]);
const SCOPE_KINDS = new Set<MemoryScopeKind>(["conversation", "email_thread", "task_root"]);
const FORBIDDEN_MEMORY_KEY = /^(userId|ownerUserId|authorization|cookies?|password|secret|accessToken|refreshToken|credentials?)$/i;
const MAX_MEMORY_PAYLOAD_BYTES = 256_000;

export async function appendMemoryEntry(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  scopeInput: RuntimeMemoryScope,
  input: { entryKind: MemoryEntryKind; parentEntryId?: string; payload: unknown }
) {
  const scope = memoryScope(scopeInput);
  if (!ENTRY_KINDS.has(input.entryKind)) throw new RuntimeHttpError(422, "memory_entry_kind_invalid");
  assertMemoryPayloadSafe(input.payload);
  const payloadJson = canonicalJson(input.payload);
  const byteSize = new TextEncoder().encode(payloadJson).byteLength;
  if (byteSize > MAX_MEMORY_PAYLOAD_BYTES) throw new RuntimeHttpError(413, "memory_entry_too_large");
  const sequenceRow = await db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
    FROM mate_memory_entries
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ?
      AND scope_kind = ? AND scope_id = ?
  `).bind(mateId, principal.userId, mode, scope.kind, scope.id).first<{ sequence?: number }>();
  const sequence = Number(sequenceRow?.sequence || 1);
  const id = `memory_${randomId()}`;
  const now = new Date().toISOString();
  const payloadDigest = await sha256Digest(payloadJson);
  const estimatedTokens = estimateTokens(payloadJson);
  const parentEntryId = optionalIdentifier(input.parentEntryId);
  await db.prepare(`
    INSERT INTO mate_memory_entries (
      mate_id, user_id, runtime_mode, scope_kind, scope_id, id, sequence,
      parent_entry_id, entry_kind, payload_json, payload_digest, estimated_tokens, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    mateId, principal.userId, mode, scope.kind, scope.id, id, sequence,
    parentEntryId || null, input.entryKind, payloadJson, payloadDigest, estimatedTokens, now
  ).run();
  return readMemoryEntry(db, mateId, principal, mode, scope, id);
}

export async function listOriginalMemoryEntries(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  scopeInput: RuntimeMemoryScope
) {
  const scope = memoryScope(scopeInput);
  const rows = await db.prepare(`
    SELECT id, sequence, parent_entry_id AS parentEntryId, entry_kind AS entryKind,
           payload_json AS payloadJson, payload_digest AS payloadDigest,
           estimated_tokens AS estimatedTokens, created_at AS createdAt
    FROM mate_memory_entries
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ?
      AND scope_kind = ? AND scope_id = ?
    ORDER BY sequence
  `).bind(mateId, principal.userId, mode, scope.kind, scope.id).all<Record<string, unknown>>();
  return (rows.results ?? []).map(memoryEntryFromRow);
}

export async function createMemoryCompaction(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  scopeInput: RuntimeMemoryScope,
  input: {
    fromSequence: number;
    modelId: string;
    policyVersion: string;
    releaseId: string;
    summary: Record<string, unknown>;
    toSequence: number;
  }
) {
  const scope = memoryScope(scopeInput);
  const fromSequence = positiveInteger(input.fromSequence, "memory_compaction_range_invalid");
  const toSequence = positiveInteger(input.toSequence, "memory_compaction_range_invalid");
  if (toSequence < fromSequence) throw new RuntimeHttpError(422, "memory_compaction_range_invalid");
  assertMemoryPayloadSafe(input.summary);
  const summaryText = text(input.summary.summary);
  if (!summaryText) throw new RuntimeHttpError(422, "memory_compaction_summary_required");
  const summaryJson = canonicalJson(input.summary);
  if (new TextEncoder().encode(summaryJson).byteLength > MAX_MEMORY_PAYLOAD_BYTES) {
    throw new RuntimeHttpError(413, "memory_compaction_summary_too_large");
  }
  const rows = await db.prepare(`
    SELECT id, sequence, entry_kind AS entryKind, payload_json AS payloadJson,
           payload_digest AS payloadDigest, estimated_tokens AS estimatedTokens
    FROM mate_memory_entries
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ?
      AND scope_kind = ? AND scope_id = ? AND sequence BETWEEN ? AND ?
    ORDER BY sequence
  `).bind(
    mateId, principal.userId, mode, scope.kind, scope.id, fromSequence, toSequence
  ).all<Record<string, unknown>>();
  const sourceRows = rows.results ?? [];
  if (sourceRows.length !== toSequence - fromSequence + 1) {
    throw new RuntimeHttpError(409, "memory_compaction_source_incomplete");
  }
  const active = await readActiveCompaction(db, mateId, principal, mode, scope);
  if (active && (fromSequence > active.fromSequence || toSequence < active.toSequence)) {
    throw new RuntimeHttpError(409, "memory_compaction_must_expand_active_range");
  }
  const sourceJson = canonicalJson(sourceRows.map((row) => ({
    entryKind: row.entryKind,
    id: row.id,
    payloadDigest: row.payloadDigest,
    sequence: Number(row.sequence)
  })));
  const id = `compaction_${randomId()}`;
  const now = new Date().toISOString();
  const sourceDigest = await sha256Digest(sourceJson);
  const summaryDigest = await sha256Digest(summaryJson);
  const sourceTokenEstimate = sourceRows.reduce((sum, row) => sum + Number(row.estimatedTokens || 0), 0);
  const summaryTokenEstimate = estimateTokens(summaryJson);
  await db.batch([
    db.prepare(`
      UPDATE mate_memory_compactions SET status = 'superseded'
      WHERE mate_id = ? AND user_id = ? AND runtime_mode = ?
        AND scope_kind = ? AND scope_id = ? AND status = 'active'
    `).bind(mateId, principal.userId, mode, scope.kind, scope.id),
    db.prepare(`
      INSERT INTO mate_memory_compactions (
        mate_id, user_id, runtime_mode, scope_kind, scope_id, id,
        previous_compaction_id, from_sequence, to_sequence, summary_json,
        source_digest, summary_digest, source_token_estimate, summary_token_estimate,
        model_id, release_id, policy_version, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).bind(
      mateId, principal.userId, mode, scope.kind, scope.id, id,
      active?.id || null, fromSequence, toSequence, summaryJson,
      sourceDigest, summaryDigest, sourceTokenEstimate, summaryTokenEstimate,
      requiredText(input.modelId, "memory_compaction_model_required", 128),
      requiredText(input.releaseId, "memory_compaction_release_required", 128),
      requiredText(input.policyVersion, "memory_compaction_policy_required", 128), now
    )
  ]);
  return readActiveCompaction(db, mateId, principal, mode, scope);
}

export async function readCompactedMemoryContext(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  scopeInput: RuntimeMemoryScope
) {
  const scope = memoryScope(scopeInput);
  const originals = await listOriginalMemoryEntries(db, mateId, principal, mode, scope);
  const compaction = await readActiveCompaction(db, mateId, principal, mode, scope);
  if (!compaction) return { compaction: null, entries: originals, originalEntryCount: originals.length };
  const entries = [
    ...originals.filter((entry) => entry.sequence < compaction.fromSequence),
    {
      createdAt: compaction.createdAt,
      entryKind: "compaction_summary" as const,
      estimatedTokens: compaction.summaryTokenEstimate,
      id: compaction.id,
      payload: compaction.summary,
      payloadDigest: compaction.summaryDigest,
      sequenceRange: { from: compaction.fromSequence, to: compaction.toSequence }
    },
    ...originals.filter((entry) => entry.sequence > compaction.toSequence)
  ];
  return { compaction, entries, originalEntryCount: originals.length };
}

async function readMemoryEntry(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  scope: RuntimeMemoryScope,
  id: string
) {
  const row = await db.prepare(`
    SELECT id, sequence, parent_entry_id AS parentEntryId, entry_kind AS entryKind,
           payload_json AS payloadJson, payload_digest AS payloadDigest,
           estimated_tokens AS estimatedTokens, created_at AS createdAt
    FROM mate_memory_entries
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ?
      AND scope_kind = ? AND scope_id = ? AND id = ?
  `).bind(mateId, principal.userId, mode, scope.kind, scope.id, id).first<Record<string, unknown>>();
  if (!row) throw new RuntimeHttpError(404, "memory_entry_not_found");
  return memoryEntryFromRow(row);
}

async function readActiveCompaction(
  db: D1Database,
  mateId: string,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  scope: RuntimeMemoryScope
): Promise<RuntimeMemoryCompaction | null> {
  const row = await db.prepare(`
    SELECT id, previous_compaction_id AS previousCompactionId,
           from_sequence AS fromSequence, to_sequence AS toSequence,
           summary_json AS summaryJson, source_digest AS sourceDigest,
           summary_digest AS summaryDigest, source_token_estimate AS sourceTokenEstimate,
           summary_token_estimate AS summaryTokenEstimate, model_id AS modelId,
           release_id AS releaseId, policy_version AS policyVersion, status, created_at AS createdAt
    FROM mate_memory_compactions
    WHERE mate_id = ? AND user_id = ? AND runtime_mode = ?
      AND scope_kind = ? AND scope_id = ? AND status = 'active'
    LIMIT 1
  `).bind(mateId, principal.userId, mode, scope.kind, scope.id).first<Record<string, unknown>>();
  return row ? memoryCompactionFromRow(row) : null;
}

function memoryEntryFromRow(row: Record<string, unknown>): RuntimeMemoryEntry {
  return {
    createdAt: String(row.createdAt || ""),
    entryKind: String(row.entryKind) as MemoryEntryKind,
    estimatedTokens: Number(row.estimatedTokens || 0),
    id: String(row.id || ""),
    ...(row.parentEntryId ? { parentEntryId: String(row.parentEntryId) } : {}),
    payload: parseJson(row.payloadJson),
    payloadDigest: String(row.payloadDigest || ""),
    sequence: Number(row.sequence || 0)
  };
}

function memoryCompactionFromRow(row: Record<string, unknown>): RuntimeMemoryCompaction {
  return {
    createdAt: String(row.createdAt || ""),
    fromSequence: Number(row.fromSequence || 0),
    id: String(row.id || ""),
    modelId: String(row.modelId || ""),
    policyVersion: String(row.policyVersion || ""),
    ...(row.previousCompactionId ? { previousCompactionId: String(row.previousCompactionId) } : {}),
    releaseId: String(row.releaseId || ""),
    sourceDigest: String(row.sourceDigest || ""),
    sourceTokenEstimate: Number(row.sourceTokenEstimate || 0),
    status: String(row.status) as RuntimeMemoryCompaction["status"],
    summary: parseJson(row.summaryJson) as Record<string, unknown>,
    summaryDigest: String(row.summaryDigest || ""),
    summaryTokenEstimate: Number(row.summaryTokenEstimate || 0),
    toSequence: Number(row.toSequence || 0)
  };
}

function memoryScope(input: RuntimeMemoryScope): RuntimeMemoryScope {
  if (!SCOPE_KINDS.has(input.kind)) throw new RuntimeHttpError(422, "memory_scope_kind_invalid");
  return { id: requiredIdentifier(input.id, "memory_scope_id_invalid"), kind: input.kind };
}

function assertMemoryPayloadSafe(value: unknown, depth = 0) {
  if (depth > 12) throw new RuntimeHttpError(422, "memory_payload_too_deep");
  if (Array.isArray(value)) {
    value.forEach((item) => assertMemoryPayloadSafe(item, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_MEMORY_KEY.test(key)) throw new RuntimeHttpError(400, "memory_authority_field_forbidden", { field: key });
    assertMemoryPayloadSafe(child, depth + 1);
  }
}

function canonicalJson(value: unknown) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortJson(child)]));
}

function parseJson(value: unknown) {
  try { return JSON.parse(String(value || "null")); }
  catch { throw new RuntimeHttpError(500, "memory_json_corrupt"); }
}

function estimateTokens(value: string) {
  return Math.max(1, Math.ceil(new TextEncoder().encode(value).byteLength / 4));
}

function positiveInteger(value: unknown, code: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new RuntimeHttpError(422, code);
  return number;
}

function requiredIdentifier(value: unknown, code: string) {
  const id = text(value);
  if (!/^[A-Za-z0-9_-]{4,180}$/.test(id)) throw new RuntimeHttpError(422, code);
  return id;
}

function optionalIdentifier(value: unknown) {
  const id = text(value);
  return id ? requiredIdentifier(id, "memory_parent_entry_id_invalid") : undefined;
}

function requiredText(value: unknown, code: string, maxLength: number) {
  const result = text(value);
  if (!result || result.length > maxLength) throw new RuntimeHttpError(422, code);
  return result;
}

function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function randomId() { return crypto.randomUUID().replaceAll("-", ""); }
async function sha256Digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
