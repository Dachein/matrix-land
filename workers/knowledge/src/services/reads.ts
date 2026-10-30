import { canonicalPermissionRole, roleHasKnowledgeCapability, roleRank } from "../access/policy.ts";
import { HttpError } from "../http.ts";
import { namespaceJson } from "../namespaces/representation.ts";
import { requireCurrentVersion, requireObject } from "../objects/repository.ts";
import { objectJsonForPrincipal, objectJsonListForPrincipal, versionJson } from "../objects/representation.ts";
import { HANDBOOK_FILE_NAME, KNOWLEDGE_ACTION_MAX_TEXT_BYTES } from "../policy.ts";
import type { Env, KnowledgeServiceRow, KnowledgeServiceVersionRow, ObjectRow, Principal } from "../types.ts";
import { requireReadableKnowledgeService } from "./access.ts";
import { latestServiceVersion } from "./repository.ts";
import { knowledgeServiceCardJson, knowledgeServiceJson } from "./representation.ts";
import { readKnowledgeServiceAccessSettings } from "./viewerAcl.ts";

export async function readKnowledgeService(env: Env, principal: Principal, serviceId: string) {
  const service = await requireReadableKnowledgeService(env, principal, serviceId);
  const access = roleHasKnowledgeCapability(service.effectiveRole, "manageService")
    ? await readKnowledgeServiceAccessSettings(env, service.namespace, service.folder, service.row.id)
    : undefined;
  const serviceJson = knowledgeServiceJson(service.row, await latestServiceVersion(env, service.row.id), service.effectiveRole, access);
  return {
    service: serviceJson,
    folder: await objectJsonForPrincipal(env, service.folder, principal),
    namespace: namespaceJson(service.namespace)
  };
}

export async function listKnowledgeServices(
  env: Env,
  principal: Principal,
  options: { cardView?: boolean } = {}
) {
  const rows = await env.KNOWLEDGE_DB
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
      JOIN knowledge_namespaces ON knowledge_namespaces.id = knowledge_services.namespace_id
      JOIN knowledge_objects AS folder ON folder.id = knowledge_services.folder_object_id
      LEFT JOIN knowledge_service_profiles AS profile ON profile.service_id = knowledge_services.id
      LEFT JOIN knowledge_service_routing_cards AS routing_card ON routing_card.service_id = knowledge_services.id
      WHERE knowledge_services.status = 'active'
        AND knowledge_services.agent_enabled = 1
        AND folder.deleted_at IS NULL
        AND knowledge_namespaces.org_id = ?
      ORDER BY knowledge_services.updated_at DESC
      LIMIT 500
      `
    )
    .bind(principal.orgId)
    .all<KnowledgeServiceRow>();
  const serviceRows = rows.results ?? [];
  if (serviceRows.length === 0) {
    return [];
  }

  // Project folders and ACLs in batches. Serial namespace, object,
  // permission and version queries made list latency grow with every service.
  const folders = await knowledgeObjectsByIds(env, serviceRows.map((row) => row.folder_object_id));
  const projectedFolders = await objectJsonListForPrincipal(env, folders, principal);
  const projectedFolderById = new Map(projectedFolders.map((folder) => [folder.id, folder]));
  const visibleRows = serviceRows.flatMap((row) => {
    const folder = projectedFolderById.get(row.folder_object_id);
    const effectiveRole = canonicalPermissionRole(folder?.effectiveRole);
    return folder && roleRank(effectiveRole) >= roleRank("viewer")
      ? [{ effectiveRole, folder, row }]
      : [];
  });

  if (options.cardView) {
    return visibleRows.map(({ effectiveRole, row }) => knowledgeServiceCardJson(row, effectiveRole));
  }

  const [collaboratorsByService, latestVersionByService] = await Promise.all([
    knowledgeServiceCollaboratorsByService(env, principal.orgId),
    latestKnowledgeServiceVersionsByServiceId(env, visibleRows.map(({ row }) => row.id))
  ]);
  return visibleRows.map(({ effectiveRole, folder, row }) => ({
    ...knowledgeServiceJson(row, latestVersionByService.get(row.id), effectiveRole),
    collaboratorUserIds: collaboratorsByService.get(row.id) ?? [],
    folder
  }));
}

export async function readKnowledgeServiceHandbook(env: Env, principal: Principal, serviceId: string) {
  const readable = await requireReadableKnowledgeService(env, principal, serviceId);
  const handbook = await requireObject(env, readable.row.handbook_object_id);
  if (handbook.object_kind !== "file" || handbook.file_name !== HANDBOOK_FILE_NAME || handbook.parent_path !== readable.folder.path) {
    throw new HttpError(409, "knowledge_service_handbook_invalid");
  }
  const version = await requireCurrentVersion(env, handbook);
  if (version.size_bytes > KNOWLEDGE_ACTION_MAX_TEXT_BYTES) {
    throw new HttpError(413, "knowledge_service_handbook_too_large");
  }
  const r2Object = await env.KNOWLEDGE_OBJECTS.get(version.r2_key);
  if (!r2Object) {
    throw new HttpError(404, "knowledge_service_handbook_missing");
  }
  return {
    service: knowledgeServiceJson(readable.row, await latestServiceVersion(env, readable.row.id), readable.effectiveRole),
    handbook: await objectJsonForPrincipal(env, handbook, principal),
    content: new TextDecoder().decode(await r2Object.arrayBuffer()),
    version: versionJson(version)
  };
}

async function knowledgeObjectsByIds(env: Env, objectIds: string[]) {
  const objects: ObjectRow[] = [];
  const uniqueIds = [...new Set(objectIds.filter(Boolean))];
  for (let offset = 0; offset < uniqueIds.length; offset += 80) {
    const chunk = uniqueIds.slice(offset, offset + 80);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await env.KNOWLEDGE_DB
      .prepare(`SELECT * FROM knowledge_objects WHERE deleted_at IS NULL AND id IN (${placeholders})`)
      .bind(...chunk)
      .all<ObjectRow>();
    objects.push(...(result.results ?? []));
  }
  return objects;
}

async function latestKnowledgeServiceVersionsByServiceId(env: Env, serviceIds: string[]) {
  const latestByServiceId = new Map<string, KnowledgeServiceVersionRow>();
  const uniqueIds = [...new Set(serviceIds.filter(Boolean))];
  for (let offset = 0; offset < uniqueIds.length; offset += 80) {
    const chunk = uniqueIds.slice(offset, offset + 80);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await env.KNOWLEDGE_DB
      .prepare(
        `SELECT * FROM knowledge_service_versions
         WHERE status = 'active' AND service_id IN (${placeholders})
         ORDER BY service_id, version DESC`
      )
      .bind(...chunk)
      .all<KnowledgeServiceVersionRow>();
    for (const version of result.results ?? []) {
      if (!latestByServiceId.has(version.service_id)) {
        latestByServiceId.set(version.service_id, version);
      }
    }
  }
  return latestByServiceId;
}

async function knowledgeServiceCollaboratorsByService(env: Env, orgId: string) {
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT service.id AS service_id, permission.subject_id
      FROM knowledge_services AS service
      JOIN knowledge_namespaces AS namespace ON namespace.id = service.namespace_id
      JOIN knowledge_permissions AS permission ON permission.object_id = service.folder_object_id
      WHERE namespace.org_id = ?
        AND service.status = 'active'
        AND service.agent_enabled = 1
        AND permission.subject_type = 'user'
        AND permission.role IN ('editor', 'collaborator')
        AND permission.revoked_at IS NULL
        AND (permission.expires_at IS NULL OR datetime(permission.expires_at) > CURRENT_TIMESTAMP)
      ORDER BY permission.created_at, permission.id
      `
    )
    .bind(orgId)
    .all<{ service_id: string; subject_id: string }>();
  const collaborators = new Map<string, string[]>();
  for (const row of rows.results ?? []) {
    const current = collaborators.get(row.service_id) ?? [];
    if (!current.includes(row.subject_id)) current.push(row.subject_id);
    collaborators.set(row.service_id, current);
  }
  return collaborators;
}
