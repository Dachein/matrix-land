import { dispatchKnowledgeIndexOutboxAfterMutation } from "../indexing/outbox.ts";
import type { Env, KnowledgeServiceRow } from "../types.ts";

export async function markKnowledgeServicesStaleForPath(env: Env, namespaceId: string, changedPath: string) {
  if (!changedPath) return;
  await env.KNOWLEDGE_DB
    .prepare(
      `
      UPDATE knowledge_services
      SET index_status = CASE WHEN index_status = 'indexing' THEN index_status ELSE 'stale' END,
          source_revision = source_revision + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE namespace_id = ?
        AND status = 'active'
        AND agent_enabled = 1
        AND folder_object_id IN (
          SELECT service_folder.id
          FROM knowledge_objects AS service_folder
          WHERE service_folder.namespace_id = ?
            AND service_folder.deleted_at IS NULL
            AND (
              ? = service_folder.path
              OR substr(?, 1, length(service_folder.path) + 1) = service_folder.path || '/'
              OR substr(service_folder.path, 1, length(?) + 1) = ? || '/'
            )
        )
      `
    )
    .bind(namespaceId, namespaceId, changedPath, changedPath, changedPath, changedPath)
    .run();
}

export async function queueKnowledgeServicesForChangedPath(
  env: Env,
  namespaceId: string,
  changedPath: string
) {
  await markKnowledgeServicesStaleForPath(env, namespaceId, changedPath);
  const services = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT service.*
       FROM knowledge_services AS service
       JOIN knowledge_objects AS folder ON folder.id = service.folder_object_id
       WHERE service.namespace_id = ? AND service.status = 'active'
         AND service.agent_enabled = 1 AND folder.deleted_at IS NULL
         AND (
           ? = folder.path
           OR substr(?, 1, length(folder.path) + 1) = folder.path || '/'
           OR substr(folder.path, 1, length(?) + 1) = ? || '/'
         )`
    )
    .bind(namespaceId, changedPath, changedPath, changedPath, changedPath)
    .all<KnowledgeServiceRow>();
  for (const service of services.results ?? []) {
    await env.KNOWLEDGE_DB
      .prepare(
        `INSERT OR IGNORE INTO knowledge_index_outbox (
           id, service_id, source_revision, object_id, operation, extractor_version
         ) VALUES (?, ?, ?, ?, 'reextract', 'builtin-v1')`
      )
      .bind(
        `kidx_${crypto.randomUUID()}`,
        service.id,
        service.source_revision,
        service.folder_object_id
      )
      .run();
  }
  await dispatchKnowledgeIndexOutboxAfterMutation(env);
}
