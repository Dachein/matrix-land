import { accessRoleForObject } from "../access/authorization.ts";
import {
  canonicalPermissionRole,
  knowledgeCapabilities,
  permissionAppliesToPrincipal,
  permissionRoleForRow,
  roleRank
} from "../access/policy.ts";
import { knowledgeV2Flags } from "../knowledge-v2-flags.ts";
import { parentPathsForPath } from "../paths.ts";
import type {
  CanonicalKnowledgeRole,
  Env,
  KnowledgeServiceRow,
  NamespaceRow,
  ObjectRow,
  PermissionRow,
  Principal,
  VersionRow
} from "../types.ts";
import { safeJsonArray } from "../values.ts";
import { isKnowledgeServiceHandbookObject } from "./access.ts";
import { requireNamespaceForPrincipal } from "./repository.ts";

export async function objectJsonForPrincipal(env: Env, row: ObjectRow, principal: Principal) {
  const namespace = await requireNamespaceForPrincipal(env, row.namespace_id, principal);
  const role = canonicalPermissionRole(await accessRoleForObject(env, namespace, row, principal));
  const rootOwner = knowledgeV2Flags(env).rootAcl
    ? await rootOwnerForObject(env, row)
    : undefined;
  const [collaboratorCount, service, protectedHandbook] = await Promise.all([
    rootCollaboratorCountForObject(env, row),
    activeKnowledgeServiceForObject(env, row),
    row.object_kind === "file" ? isKnowledgeServiceHandbookObject(env, row.id) : false
  ]);
  return objectJsonWithPrincipalAccess(
    row,
    rootOwner?.subject_id ?? namespace.owner_user_id,
    role,
    service,
    protectedHandbook,
    collaboratorCount
  );
}

export async function objectJsonListForPrincipal(
  env: Env,
  rows: ObjectRow[],
  principal: Principal,
  knownNamespace?: NamespaceRow
) {
  if (rows.length === 0) return [];
  // Break-glass reads deliberately emit one audit event per object. Keep that
  // exceptional path on the single-object projector rather than collapsing it.
  if (knowledgeV2Flags(env).rootAcl && principal.role === "admin" && principal.breakGlassReason) {
    return Promise.all(rows.map((row) => objectJsonForPrincipal(env, row, principal)));
  }

  const rowsByNamespace = new Map<string, ObjectRow[]>();
  rows.forEach((row) => rowsByNamespace.set(row.namespace_id, [
    ...(rowsByNamespace.get(row.namespace_id) ?? []),
    row
  ]));
  const projectedById = new Map<string, ReturnType<typeof objectJson>>();
  await Promise.all([...rowsByNamespace.entries()].map(async ([namespaceId, namespaceRows]) => {
    const namespace = knownNamespace?.id === namespaceId
      ? knownNamespace
      : await requireNamespaceForPrincipal(env, namespaceId, principal);
    const projected = await objectJsonListForNamespace(env, namespaceRows, namespace, principal);
    projected.forEach((item, index) => projectedById.set(namespaceRows[index].id, item));
  }));
  return rows.flatMap((row) => {
    const item = projectedById.get(row.id);
    return item ? [item] : [];
  });
}

async function objectJsonListForNamespace(
  env: Env,
  rows: ObjectRow[],
  namespace: NamespaceRow,
  principal: Principal
) {
  const ancestorPaths = [...new Set(rows.flatMap((row) => parentPathsForPath(row.path)))];
  const [ancestorFolders, permissionResult, serviceResult] = await Promise.all([
    knowledgeFoldersByPaths(env, namespace.id, ancestorPaths),
    env.KNOWLEDGE_DB
      .prepare(
        `SELECT permission.*, provenance.grant_source, provenance.source_id,
                CASE WHEN provenance.grant_source = 'knowledge_service' AND EXISTS (
                  SELECT 1 FROM knowledge_services AS service
                  WHERE service.id = provenance.source_id
                    AND service.namespace_id = permission.namespace_id
                    AND service.folder_object_id = permission.object_id
                    AND service.status = 'active' AND service.agent_enabled = 1
                ) THEN 1 ELSE 0 END AS service_grant_active
         FROM knowledge_permissions AS permission
         LEFT JOIN knowledge_permission_provenance AS provenance
           ON provenance.permission_id = permission.id
         WHERE permission.namespace_id = ?
           AND permission.revoked_at IS NULL
           AND (permission.expires_at IS NULL OR datetime(permission.expires_at) > CURRENT_TIMESTAMP)
         ORDER BY permission.object_id IS NULL ASC, permission.created_at DESC`
      )
      .bind(namespace.id)
      .all<PermissionRow>(),
    env.KNOWLEDGE_DB
      .prepare(
        `SELECT service.*, service_folder.path AS folder_path
         FROM knowledge_services AS service
         JOIN knowledge_objects AS service_folder ON service_folder.id = service.folder_object_id
         WHERE service.namespace_id = ? AND service.status != 'archived'
           AND service_folder.deleted_at IS NULL`
      )
      .bind(namespace.id)
      .all<KnowledgeServiceRow>()
  ]);
  const folderIdByPath = new Map(ancestorFolders.map((folder) => [folder.path, folder.id]));
  rows.forEach((row) => {
    if (row.object_kind === "folder") folderIdByPath.set(row.path, row.id);
  });
  const permissions = permissionResult.results ?? [];
  const services = serviceResult.results ?? [];
  const protectedHandbookIds = new Set(services.map((service) => service.handbook_object_id).filter(Boolean));

  return rows.map((row) => {
    const role = projectedAccessRole(env, namespace, row, principal, permissions, folderIdByPath);
    const service = projectedActiveKnowledgeService(row, services);
    const rootPath = row.path.split("/").filter(Boolean)[0] ?? "";
    const rootObjectId = row.object_kind === "folder" && !row.parent_path
      ? row.id
      : folderIdByPath.get(rootPath);
    const rootOwner = rootObjectId
      ? permissions.find((permission) => permission.object_id === rootObjectId
        && permission.subject_type === "user"
        && permission.role === "owner")
      : undefined;
    const collaboratorCount = rootObjectId
      ? new Set(permissions
        .filter((permission) => permission.object_id === rootObjectId
          && permission.subject_type === "user"
          && permissionRoleForRow(permission) === "collaborator"
          && permission.grant_source !== "knowledge_service")
        .map((permission) => permission.subject_id)
        .filter(Boolean)).size
      : 0;
    return objectJsonWithPrincipalAccess(
      row,
      rootOwner?.subject_id ?? namespace.owner_user_id,
      role,
      service,
      row.object_kind === "file" && protectedHandbookIds.has(row.id),
      collaboratorCount
    );
  });
}

async function knowledgeFoldersByPaths(env: Env, namespaceId: string, paths: string[]) {
  const folders: Array<{ id: string; path: string }> = [];
  for (let offset = 0; offset < paths.length; offset += 80) {
    const chunk = paths.slice(offset, offset + 80);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await env.KNOWLEDGE_DB
      .prepare(
        `SELECT id, path FROM knowledge_objects
         WHERE namespace_id = ? AND object_kind = 'folder' AND deleted_at IS NULL
           AND path IN (${placeholders})`
      )
      .bind(namespaceId, ...chunk)
      .all<{ id: string; path: string }>();
    folders.push(...(result.results ?? []));
  }
  return folders;
}

function projectedAccessRole(
  env: Env,
  namespace: NamespaceRow,
  object: ObjectRow,
  principal: Principal,
  permissions: PermissionRow[],
  folderIdByPath: Map<string, string>
): CanonicalKnowledgeRole | "none" {
  if (namespace.org_id !== principal.orgId) return "none";
  if (!knowledgeV2Flags(env).rootAcl && (namespace.owner_user_id === principal.sub || principal.role === "admin")) {
    return "owner";
  }
  const applicableObjectIds = new Set<string>([object.id]);
  parentPathsForPath(object.path).forEach((path) => {
    const objectId = folderIdByPath.get(path);
    if (objectId) applicableObjectIds.add(objectId);
  });
  let best: CanonicalKnowledgeRole | "none" = "none";
  for (const permission of permissions) {
    if (permission.object_id && !applicableObjectIds.has(permission.object_id)) continue;
    const permissionRole = permissionRoleForRow(permission);
    if (
      knowledgeV2Flags(env).rootAcl
      && permissionRole === "viewer"
      && permission.grant_source === "knowledge_service"
      && permission.service_grant_active !== 1
    ) continue;
    if (permissionAppliesToPrincipal(permission, principal) && roleRank(permissionRole) > roleRank(best)) {
      best = permissionRole;
    }
  }
  return best;
}

function projectedActiveKnowledgeService(object: ObjectRow, services: KnowledgeServiceRow[]) {
  return services
    .filter((service) => service.status === "active"
      && service.agent_enabled === 1
      && Boolean(service.folder_path)
      && (object.path === service.folder_path || object.path.startsWith(`${service.folder_path}/`)))
    .sort((left, right) => (right.folder_path?.length ?? 0) - (left.folder_path?.length ?? 0))[0];
}

function objectJsonWithPrincipalAccess(
  row: ObjectRow,
  ownerUserId: string,
  role: CanonicalKnowledgeRole | "none",
  service: KnowledgeServiceRow | null | undefined,
  protectedHandbook: boolean,
  collaboratorCount = 0
) {
  const knowledgeServiceAvailable = Boolean(service);
  const agentEnabled = service?.folder_object_id === row.id;
  const accessKind = role === "collaborator"
    ? "collaboration"
    : role === "viewer" && knowledgeServiceAvailable
      ? "knowledge_service"
      : role === "viewer"
        ? "shared"
        : role === "owner"
          ? "owner"
          : "none";
  return objectJson(row, ownerUserId, {
    accessKind,
    accessKinds: [
      ...(role === "owner" ? ["owner"] : []),
      ...(role === "collaborator" ? ["collaboration"] : []),
      ...(knowledgeServiceAvailable && role !== "owner" ? ["knowledge_service"] : []),
      ...(role === "viewer" && !knowledgeServiceAvailable ? ["shared"] : [])
    ],
    agentEnabled,
    capabilities: knowledgeCapabilities(
      role,
      knowledgeServiceAvailable,
      row.object_kind,
      protectedHandbook,
      row.object_kind === "folder" && !row.parent_path
    ),
    collaboratorCount,
    effectiveRole: role,
    indexStatus: agentEnabled ? service?.index_status : undefined,
    knowledgeServiceAvailable,
    knowledgeServiceId: agentEnabled ? service?.id : undefined
  });
}

async function rootOwnerForObject(env: Env, object: ObjectRow) {
  const rootPath = object.path.split("/").filter(Boolean)[0] ?? "";
  if (!rootPath) {
    return undefined;
  }
  return env.KNOWLEDGE_DB
    .prepare(
      `SELECT permission.*
       FROM knowledge_objects AS root
       JOIN knowledge_permissions AS permission ON permission.object_id = root.id
       WHERE root.namespace_id = ?
         AND root.path = ?
         AND root.object_kind = 'folder'
         AND root.parent_path = ''
         AND root.deleted_at IS NULL
         AND permission.subject_type = 'user'
         AND permission.role = 'owner'
         AND permission.revoked_at IS NULL
       LIMIT 1`
    )
    .bind(object.namespace_id, rootPath)
    .first<PermissionRow>();
}

async function rootCollaboratorCountForObject(env: Env, object: ObjectRow) {
  const rootPath = object.path.split("/").filter(Boolean)[0] ?? "";
  if (!rootPath) return 0;
  const row = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT COUNT(DISTINCT permission.subject_id) AS collaborator_count
       FROM knowledge_objects AS root
       JOIN knowledge_permissions AS permission ON permission.object_id = root.id
       WHERE root.namespace_id = ?
         AND root.path = ?
         AND root.object_kind = 'folder'
         AND root.parent_path = ''
         AND root.deleted_at IS NULL
         AND permission.subject_type = 'user'
         AND permission.role IN ('editor', 'collaborator')
         AND permission.revoked_at IS NULL
         AND (permission.expires_at IS NULL OR datetime(permission.expires_at) > CURRENT_TIMESTAMP)`
    )
    .bind(object.namespace_id, rootPath)
    .first<{ collaborator_count: number }>();
  return Number(row?.collaborator_count ?? 0);
}

export async function activeKnowledgeServiceForObject(env: Env, object: ObjectRow) {
  return env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT knowledge_services.*
      FROM knowledge_services
      JOIN knowledge_objects AS service_folder ON service_folder.id = knowledge_services.folder_object_id
      WHERE knowledge_services.namespace_id = ?
        AND knowledge_services.status = 'active'
        AND knowledge_services.agent_enabled = 1
        AND service_folder.deleted_at IS NULL
        AND (
          ? = service_folder.path
          OR substr(?, 1, length(service_folder.path) + 1) = service_folder.path || '/'
        )
      ORDER BY length(service_folder.path) DESC
      LIMIT 1
      `
    )
    .bind(object.namespace_id, object.path, object.path)
    .first<KnowledgeServiceRow>();
}

function objectJson(row: ObjectRow, ownerUserId: string, access?: {
  accessKind: string;
  accessKinds: string[];
  agentEnabled: boolean;
  capabilities: ReturnType<typeof knowledgeCapabilities>;
  collaboratorCount: number;
  effectiveRole: CanonicalKnowledgeRole | "none";
  indexStatus?: KnowledgeServiceRow["index_status"];
  knowledgeServiceAvailable: boolean;
  knowledgeServiceId?: string;
}) {
  const effectiveRole = access?.effectiveRole ?? "owner";
  return {
    access: effectiveRole,
    accessKind: access?.accessKind ?? "owner",
    accessKinds: access?.accessKinds ?? ["owner"],
    agentEnabled: access?.agentEnabled ?? row.agent_enabled === 1,
    capabilities: access?.capabilities ?? knowledgeCapabilities("owner", row.agent_enabled === 1, row.object_kind),
    collaboratorCount: access?.collaboratorCount ?? 0,
    contentKind: row.content_kind,
    currentVersionId: row.current_version_id,
    description: row.description,
    id: row.id,
    kind: row.object_kind,
    mimeType: row.mime_type,
    modifiedAt: row.updated_at,
    name: row.file_name,
    objectKind: row.object_kind,
    owner: ownerUserId,
    ownerUserId,
    parentPath: row.parent_path,
    path: row.path,
    shareMode: row.share_mode === "public" || row.share_mode === "team" || row.share_mode === "company" ? row.share_mode : "private",
    sizeBytes: row.size_bytes,
    effectiveRole,
    indexStatus: access?.indexStatus,
    knowledgeServiceAvailable: access?.knowledgeServiceAvailable ?? false,
    withinKnowledgeService: access?.knowledgeServiceAvailable ?? false,
    knowledgeServiceId: access?.knowledgeServiceId,
    // Kept for one response-version as a read-only compatibility alias.
    skillReady: row.object_kind === "folder" && (access?.agentEnabled ?? row.agent_enabled === 1),
    tags: safeJsonArray(row.tags_json),
    title: row.title,
    version: row.current_version_id ? "current" : ""
  };
}

export function versionJson(row: VersionRow) {
  return {
    id: row.id,
    objectId: row.object_id,
    version: row.version,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at
  };
}
