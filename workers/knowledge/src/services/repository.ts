import { HttpError } from "../http.ts";
import type { Env, KnowledgeServiceRow, KnowledgeServiceVersionRow, ObjectRow } from "../types.ts";

// Read service metadata, active versions and folder file inventories.
export async function listKnowledgeServiceFiles(env: Env, namespaceId: string, folderPath: string) {
  const files: ObjectRow[] = [];
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const rows = await env.KNOWLEDGE_DB
      .prepare(
        `
        SELECT * FROM knowledge_objects
        WHERE namespace_id = ?
          AND object_kind = 'file'
          AND deleted_at IS NULL
          AND (
            parent_path = ?
            OR substr(parent_path, 1, length(?) + 1) = ? || '/'
          )
        ORDER BY lower(path) ASC, id ASC
        LIMIT ? OFFSET ?
        `
      )
      .bind(namespaceId, folderPath, folderPath, folderPath, pageSize, offset)
      .all<ObjectRow>();
    const page = rows.results ?? [];
    files.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
  }
  return files;
}

export async function requireKnowledgeService(env: Env, serviceId: string) {
  const service = await env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT
        knowledge_services.*,
        folder.path AS folder_path,
        folder.file_name AS folder_name,
        COALESCE(profile.category, 'general') AS category,
        COALESCE(profile.tags_json, '[]') AS tags_json,
        COALESCE(profile.languages_json, '[]') AS languages_json,
        COALESCE(profile.coverage_json, '[]') AS coverage_json,
        COALESCE(profile.not_for_json, '[]') AS not_for_json,
        COALESCE(routing_card.role_text, '') AS role_text,
        COALESCE(routing_card.search_hints_json, '[]') AS search_hints_json,
        COALESCE(profile.feedback_enabled, 1) AS feedback_enabled,
        COALESCE(profile.feedback_policy_json, '{}') AS feedback_policy_json,
        COALESCE(profile.maintenance_team, '') AS maintenance_team
      FROM knowledge_services
      JOIN knowledge_objects AS folder ON folder.id = knowledge_services.folder_object_id
      LEFT JOIN knowledge_service_profiles AS profile ON profile.service_id = knowledge_services.id
      LEFT JOIN knowledge_service_routing_cards AS routing_card ON routing_card.service_id = knowledge_services.id
      WHERE knowledge_services.id = ?
      LIMIT 1
      `
    )
    .bind(serviceId)
    .first<KnowledgeServiceRow>();
  if (!service) {
    throw new HttpError(404, "knowledge_service_not_found");
  }
  return service;
}

export async function latestServiceVersion(env: Env, serviceId: string) {
  return env.KNOWLEDGE_DB
    .prepare("SELECT * FROM knowledge_service_versions WHERE service_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1")
    .bind(serviceId)
    .first<KnowledgeServiceVersionRow>();
}

export async function requireServiceVersion(env: Env, versionId: string) {
  const version = await env.KNOWLEDGE_DB.prepare("SELECT * FROM knowledge_service_versions WHERE id = ?").bind(versionId).first<KnowledgeServiceVersionRow>();
  if (!version) {
    throw new HttpError(404, "knowledge_service_version_not_found");
  }
  return version;
}
