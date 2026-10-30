import { HttpError } from "../http.ts";
import { reindexKnowledgeService } from "../indexing/reindex.ts";
import { knowledgeV2Flags } from "../knowledge-v2-flags.ts";
import { requireReadableKnowledgeService } from "../services/access.ts";
import { latestServiceVersion } from "../services/repository.ts";
import { knowledgeServiceSnapshots } from "../services/snapshots.ts";
import type { Env, Principal } from "../types.ts";

// Require a prepared canonical index; preserve legacy automatic refresh when the read flag is disabled.
export async function canonicalIndexContext(env: Env, principal: Principal, serviceId: string) {
  const readable = await requireReadableKnowledgeService(env, principal, serviceId);
  const version = await latestServiceVersion(env, readable.row.id);
  const indexState = await env.KNOWLEDGE_DB
    .prepare("SELECT * FROM knowledge_service_index_state WHERE service_id = ?")
    .bind(readable.row.id)
    .first<{
      blocked_object_count: number;
      indexed_revision: number;
      last_error: string;
      pending_object_count: number;
      skipped_object_count: number;
      source_revision: number;
      status: string;
    }>();
  if (!version) {
    throw new HttpError(409, "knowledge_service_index_not_ready");
  }
  if (
    readable.row.index_status !== "ready"
    || !["ready", "partial"].includes(indexState?.status ?? "")
    || Number(indexState?.indexed_revision) !== Number(readable.row.source_revision)
  ) {
    throw new HttpError(409, "knowledge_service_index_not_ready");
  }
  return {
    ...readable,
    indexState,
    service: readable.row,
    version
  };
}

export function canonicalIndexStatus(context: Awaited<ReturnType<typeof canonicalIndexContext>>) {
  return {
    blockedObjectCount: Number(context.indexState?.blocked_object_count ?? 0),
    indexedRevision: Number(context.indexState?.indexed_revision ?? 0),
    pendingObjectCount: Number(context.indexState?.pending_object_count ?? 0),
    skippedObjectCount: Number(context.indexState?.skipped_object_count ?? 0),
    sourceRevision: Number(context.indexState?.source_revision ?? 0),
    status: context.indexState?.status ?? "error"
  };
}

export async function readableKnowledgeServiceContext(env: Env, principal: Principal, serviceId: string) {
  let readable = await requireReadableKnowledgeService(env, principal, serviceId);
  let version = await latestServiceVersion(env, readable.row.id);
  if (
    knowledgeV2Flags(env).indexRead
    && (!version || readable.row.index_status !== "ready")
  ) {
    throw new HttpError(409, "knowledge_service_index_not_ready");
  }
  if (!version || readable.row.index_status === "queued" || readable.row.index_status === "stale" || readable.row.index_status === "error") {
    const indexed = await reindexKnowledgeService(env, readable.row, readable.row.created_by_user_id || principal.sub);
    readable = { ...readable, row: indexed.service };
    version = indexed.version;
  }
  if (readable.row.index_status !== "ready") {
    // Never fall back to an older snapshot while a refresh is in progress or
    // otherwise incomplete: deleted or changed source files must not leak.
    throw new HttpError(409, "knowledge_service_index_not_ready");
  }
  if (!version) {
    throw new HttpError(404, "knowledge_service_version_not_found");
  }
  return {
    service: readable.row,
    folder: readable.folder,
    namespace: readable.namespace,
    effectiveRole: readable.effectiveRole,
    version,
    snapshots: knowledgeServiceSnapshots(version)
  };
}
