import { writeAuditEvent } from "../audit/events.ts";
import { safeErrorName } from "../errors.ts";
import { HttpError } from "../http.ts";
import { requireCurrentVersion, requireNamespace, requireObject } from "../objects/repository.ts";
import { relativeKnowledgePath } from "../paths.ts";
import { HANDBOOK_FILE_NAME } from "../policy.ts";
import { listKnowledgeServiceFiles, requireKnowledgeService, requireServiceVersion } from "../services/repository.ts";
import type { Env, KnowledgeServiceRow } from "../types.ts";
import { replaceCanonicalKnowledgeIndex } from "./build.ts";

// Publish a new service snapshot only after rebuilding the canonical index.
export async function reindexKnowledgeService(env: Env, source: KnowledgeServiceRow, actorUserId: string) {
  const service = await requireKnowledgeService(env, source.id);
  if (service.agent_enabled !== 1 || service.status !== "active") {
    throw new HttpError(409, "knowledge_service_not_active");
  }
  const folder = await requireObject(env, service.folder_object_id);
  const handbook = await requireObject(env, service.handbook_object_id);
  if (handbook.file_name !== HANDBOOK_FILE_NAME || handbook.parent_path !== folder.path) {
    throw new HttpError(409, "knowledge_service_handbook_invalid");
  }
  await env.KNOWLEDGE_DB.prepare("UPDATE knowledge_services SET index_status = 'indexing', last_error = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(service.id).run();
  try {
    const handbookVersion = await requireCurrentVersion(env, handbook);
    const files = await listKnowledgeServiceFiles(env, service.namespace_id, folder.path);
    if (!files.some((file) => file.id === handbook.id)) {
      throw new HttpError(409, "knowledge_service_handbook_outside_folder");
    }
    const objectVersions = files
      .filter((file) => file.current_version_id)
      .map((file) => ({
        objectId: file.id,
        versionId: file.current_version_id,
        path: file.path,
        relativePath: relativeKnowledgePath(folder.path, file.path),
        fileName: file.file_name,
        contentKind: file.content_kind,
        mimeType: file.mime_type,
        sizeBytes: file.size_bytes,
        sha256: file.sha256,
        isHandbook: file.id === handbook.id
      }));
    const serviceVersionId = `ksver_${crypto.randomUUID()}`;
    const manifest = {
      schemaVersion: "workspace.knowledge-service.v1",
      type: "knowledge_service",
      serviceId: service.id,
      name: service.name,
      description: service.description,
      accessModel: "folder_acl",
      agentEnabled: true,
      actions: ["handbook", "search", "grep", "read"],
      folderObjectId: folder.id,
      folderPath: folder.path,
      handbookObjectId: handbook.id,
      generatedAt: new Date().toISOString()
    };
    // Canonical indexing is a write-path concern and must continue during a
    // legacy-read/shadow rollout. The flag controls only which query path
    // serves results; coupling it to index construction can falsely complete
    // the outbox while leaving the canonical revision behind.
    await replaceCanonicalKnowledgeIndex(env, service, objectVersions);
    await env.KNOWLEDGE_DB.batch([
      env.KNOWLEDGE_DB
        .prepare("UPDATE knowledge_service_versions SET status = 'archived' WHERE service_id = ? AND status = 'active'")
        .bind(service.id),
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_service_versions (
             id, service_id, version, handbook_version_id, manifest_json, object_versions_json, status, created_by_user_id
           ) VALUES (
             ?, ?,
             (SELECT COALESCE(MAX(version), 0) + 1 FROM knowledge_service_versions WHERE service_id = ?),
             ?, ?, ?, 'active', ?
           )`
        )
        .bind(serviceVersionId, service.id, service.id, handbookVersion.id, JSON.stringify(manifest), JSON.stringify(objectVersions), actorUserId),
      env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_services
           SET index_status = 'ready', index_generation = index_generation + 1, indexed_at = CURRENT_TIMESTAMP,
               last_error = '', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .bind(service.id)
    ]);
    const indexedService = await requireKnowledgeService(env, service.id);
    const indexedVersion = await requireServiceVersion(env, serviceVersionId);
    const namespace = await requireNamespace(env, service.namespace_id);
    await writeAuditEvent(env, {
      action: "knowledge.service.reindex",
      actorUserId,
      metadata: { fileCount: objectVersions.length, generation: indexedService.index_generation, serviceId: service.id },
      namespace,
      objectId: folder.id
    });
    return { service: indexedService, version: indexedVersion };
  } catch (error) {
    const message = error instanceof HttpError ? error.code : "knowledge_service_index_failed";
    console.error("knowledge_service_index_failed", { errorName: safeErrorName(error), serviceId: service.id });
    await env.KNOWLEDGE_DB
      .prepare("UPDATE knowledge_services SET index_status = 'error', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(message, service.id)
      .run();
    throw error;
  }
}
