import type { Env, ObjectRow } from "../types.ts";

// Include index invalidation in the object mutation batch; dispatch runs after commit.

export function indexOutboxStatements(
  env: Env,
  object: ObjectRow,
  changeSetId: string,
  versionId: string,
  operation: "upsert" | "delete" | "rename" | "backfill" | "reextract",
  outboxPrefix: string,
  commandId: string
) {
  const serviceMatch = `
    service.namespace_id = ?
    AND service.status = 'active'
    AND service.agent_enabled = 1
    AND EXISTS (
      SELECT 1 FROM knowledge_objects AS folder
      WHERE folder.id = service.folder_object_id
        AND folder.deleted_at IS NULL
        AND (? = folder.path OR substr(?, 1, length(folder.path) + 1) = folder.path || '/')
    )
  `;
  return [
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_index_outbox (
           id, service_id, change_set_id, source_revision, object_id, version_id,
           operation, extractor_version
         )
         SELECT ? || ':' || service.id, service.id, ?, service.source_revision + 1, ?, ?, ?, 'builtin-v1'
         FROM knowledge_services AS service
         WHERE ${serviceMatch}
           AND EXISTS (
             SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
           )`
      )
      .bind(
        outboxPrefix,
        changeSetId,
        object.id,
        versionId,
        operation,
        object.namespace_id,
        object.path,
        object.path,
        commandId
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_services AS service
         SET source_revision = source_revision + 1,
             index_status = 'stale',
             updated_at = CURRENT_TIMESTAMP
         WHERE ${serviceMatch}
           AND EXISTS (
             SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
           )`
      )
      .bind(object.namespace_id, object.path, object.path, commandId),
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_service_index_state (
           service_id, source_revision, indexed_revision, index_generation, status,
           pending_object_count, updated_at
         )
         SELECT service.id, service.source_revision, 0, service.index_generation, 'queued', 1, CURRENT_TIMESTAMP
         FROM knowledge_services AS service
         WHERE ${serviceMatch}
           AND EXISTS (
             SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
           )
         ON CONFLICT(service_id) DO UPDATE SET
           source_revision = excluded.source_revision,
           status = 'queued',
           pending_object_count = knowledge_service_index_state.pending_object_count + 1,
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(object.namespace_id, object.path, object.path, commandId)
  ];
}
