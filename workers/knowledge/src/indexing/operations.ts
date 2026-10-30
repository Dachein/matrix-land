import { HttpError } from "../http.ts";
import type { Env, Principal } from "../types.ts";
import { dispatchKnowledgeIndexOutbox } from "./outbox.ts";

// Reconcile index and storage invariants and report operational backlog.
export function assertKnowledgeOpsPrincipal(principal: Principal) {
  if (
    principal.role !== "admin"
    || !principal.scopes.some((scope) => scope === "workspace:knowledge:admin" || scope === "workspace:*")
    || !principal.breakGlassReason
  ) {
    throw new HttpError(403, "knowledge_ops_break_glass_required");
  }
}

export async function knowledgeOpsMetrics(env: Env) {
  const row = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM knowledge_index_outbox WHERE status IN ('pending', 'dispatching', 'dispatched', 'failed')) AS index_backlog,
         (SELECT COALESCE(CAST((julianday('now') - julianday(MIN(created_at))) * 86400 AS INTEGER), 0)
          FROM knowledge_index_outbox WHERE status IN ('pending', 'dispatching', 'dispatched', 'failed')) AS index_oldest_age_seconds,
         (SELECT COUNT(*) FROM knowledge_diff_outbox WHERE status IN ('pending', 'dispatching', 'dispatched', 'failed')) AS diff_backlog,
         (SELECT COALESCE(CAST((julianday('now') - julianday(MIN(created_at))) * 86400 AS INTEGER), 0)
          FROM knowledge_diff_outbox WHERE status IN ('pending', 'dispatching', 'dispatched', 'failed')) AS diff_oldest_age_seconds,
         (SELECT COUNT(*) FROM knowledge_services WHERE index_status IN ('queued', 'stale', 'error')) AS stale_services,
         (SELECT COUNT(*) FROM knowledge_ingestion_states WHERE scan_status = 'pending') AS scan_pending,
         (SELECT COUNT(*) FROM knowledge_ingestion_states WHERE scan_status IN ('blocked', 'error')) AS scan_blocked,
         (SELECT COUNT(*) FROM knowledge_audit_events
          WHERE decision = 'deny' AND created_at >= datetime('now', '-24 hours')) AS acl_denies_24h,
         (SELECT COUNT(*) FROM knowledge_shadow_query_reports
          WHERE divergent = 1 AND created_at >= datetime('now', '-24 hours')) AS shadow_divergent_24h,
         (SELECT COUNT(*) FROM knowledge_shadow_query_reports
          WHERE stale_leak_detected = 1 AND created_at >= datetime('now', '-24 hours')) AS shadow_stale_leaks_24h,
         (SELECT COUNT(*) FROM knowledge_mutation_commands
          WHERE status = 'prepared' AND created_at < datetime('now', '-10 minutes')) AS stale_mutations`
    )
    .first<Record<string, unknown>>();
  return {
    aclDenies24h: Number(row?.acl_denies_24h ?? 0),
    diffBacklog: Number(row?.diff_backlog ?? 0),
    diffOldestAgeSeconds: Number(row?.diff_oldest_age_seconds ?? 0),
    indexBacklog: Number(row?.index_backlog ?? 0),
    indexOldestAgeSeconds: Number(row?.index_oldest_age_seconds ?? 0),
    scanBlocked: Number(row?.scan_blocked ?? 0),
    scanPending: Number(row?.scan_pending ?? 0),
    shadowDivergent24h: Number(row?.shadow_divergent_24h ?? 0),
    shadowStaleLeaks24h: Number(row?.shadow_stale_leaks_24h ?? 0),
    staleMutations: Number(row?.stale_mutations ?? 0),
    staleServices: Number(row?.stale_services ?? 0)
  };
}

export async function reconcileKnowledgeServiceState(env: Env) {
  // Repair safety invariants before reporting metrics. This also makes the
  // reconciliation loop self-healing for Services created during a staged
  // rollout where canonical writes were previously disabled.
  await env.KNOWLEDGE_DB.batch([
    env.KNOWLEDGE_DB.prepare(
      `DELETE FROM knowledge_index_documents
       WHERE EXISTS (
         SELECT 1
         FROM knowledge_services AS service
         WHERE service.id = knowledge_index_documents.service_id
           AND (service.status != 'active' OR service.agent_enabled != 1)
       )
       OR EXISTS (
         SELECT 1
         FROM knowledge_objects AS object
         WHERE object.id = knowledge_index_documents.object_id
           AND (
             object.deleted_at IS NOT NULL
             OR object.current_version_id != knowledge_index_documents.version_id
           )
       )`
    ),
    env.KNOWLEDGE_DB.prepare(
      `UPDATE knowledge_service_index_state
       SET indexed_revision = 0,
           status = 'disabled',
           pending_object_count = 0,
           skipped_object_count = 0,
           blocked_object_count = 0,
           last_error = '',
           indexed_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE EXISTS (
         SELECT 1
         FROM knowledge_services AS service
         WHERE service.id = knowledge_service_index_state.service_id
           AND (service.status != 'active' OR service.agent_enabled != 1)
       )`
    ),
    env.KNOWLEDGE_DB.prepare(
      `INSERT OR IGNORE INTO knowledge_index_outbox (
         id, service_id, change_set_id, source_revision, object_id, version_id,
         operation, extractor_version, payload_hash, status
       )
       SELECT
         'kidx_reconcile:' || service.id || ':' || service.source_revision || ':' || service.index_generation,
         service.id,
         NULL,
         service.source_revision,
         service.folder_object_id,
         '',
         'backfill',
         'builtin-v1',
         '',
         'pending'
       FROM knowledge_services AS service
       LEFT JOIN knowledge_service_index_state AS state ON state.service_id = service.id
       WHERE service.status = 'active'
         AND service.agent_enabled = 1
         AND (
           state.service_id IS NULL
           OR state.indexed_revision < service.source_revision
           OR state.status NOT IN ('ready', 'partial')
         )`
    )
  ]);
  const metrics = await knowledgeOpsMetrics(env);
  if (
    metrics.diffBacklog > 0
    || metrics.indexBacklog > 0
    || metrics.scanBlocked > 0
    || metrics.staleMutations > 0
  ) {
    console.warn("knowledge_reconciliation_attention", metrics);
  }
  const currentVersions = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT object.id AS object_id, object.current_version_id AS version_id, version.r2_key
       FROM knowledge_objects AS object
       JOIN knowledge_object_versions AS version ON version.id = object.current_version_id
       WHERE object.deleted_at IS NULL
       ORDER BY object.updated_at DESC
       LIMIT 25`
    )
    .all<{ object_id: string; r2_key: string; version_id: string }>();
  for (const version of currentVersions.results ?? []) {
    const head = await env.KNOWLEDGE_OBJECTS.head(version.r2_key);
    if (!head) {
      console.error("knowledge_reconciliation_r2_missing", {
        objectId: version.object_id,
        versionId: version.version_id
      });
      await env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_ingestion_states (
             object_id, version_id, scan_status, scanner_version, reason_code, scanned_at
           ) VALUES (?, ?, 'error', 'reconciliation-v1', 'r2_object_missing', CURRENT_TIMESTAMP)
           ON CONFLICT(object_id, version_id) DO UPDATE SET
             scan_status = 'error',
             scanner_version = 'reconciliation-v1',
             reason_code = 'r2_object_missing',
             scanned_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP`
        )
        .bind(version.object_id, version.version_id)
        .run();
    }
  }
  await dispatchKnowledgeIndexOutbox(env);
}
