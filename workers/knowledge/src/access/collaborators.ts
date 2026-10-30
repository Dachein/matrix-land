import { writeAuditEvent } from "../audit/events.ts";
import { HttpError } from "../http.ts";
import { activeRootOwnerGrant } from "../objects/access.ts";
import { requireNamespaceForPrincipal, requireObject } from "../objects/repository.ts";
import { objectJsonForPrincipal } from "../objects/representation.ts";
import { publicSharesCreatedByUnselectedCollaboratorsRevokeStatement } from "../shares/revocation.ts";
import type { Env, PermissionRow, Principal } from "../types.ts";
import { accessRoleForObject } from "./authorization.ts";
import { permissionRoleForRow, roleHasKnowledgeCapability, validateSubjectId } from "./policy.ts";
import { permissionJson } from "./representation.ts";

export async function replaceFolderCollaborators(
  env: Env,
  principal: Principal,
  folderObjectId: string,
  body: Record<string, unknown>
) {
  const folder = await requireObject(env, folderObjectId);
  const namespace = await requireNamespaceForPrincipal(env, folder.namespace_id, principal);
  if (folder.object_kind !== "folder") {
    throw new HttpError(400, "knowledge_collaborators_target_not_folder");
  }
  if (folder.parent_path) {
    throw new HttpError(400, "knowledge_acl_root_required");
  }
  if (!roleHasKnowledgeCapability(
    await accessRoleForObject(env, namespace, folder, principal),
    "manageAccess"
  )) {
    throw new HttpError(403, "knowledge_collaborators_manage_denied");
  }

  const rawUserIds = body.userIds ?? body.user_ids;
  if (!Array.isArray(rawUserIds)) {
    throw new HttpError(400, "knowledge_collaborators_user_ids_required");
  }
  const desiredUserIds = [...new Set(rawUserIds.map((value) => {
    if (typeof value !== "string") {
      throw new HttpError(400, "invalid_knowledge_collaborator_user_id");
    }
    return validateSubjectId(value, "user", namespace.org_id);
  }))].sort();
  if (desiredUserIds.length > 100) {
    throw new HttpError(400, "knowledge_collaborators_too_many_users");
  }
  const ownerGrant = await activeRootOwnerGrant(env, folder.id);
  if (!ownerGrant) {
    throw new HttpError(409, "knowledge_root_owner_missing");
  }
  if (desiredUserIds.includes(ownerGrant.subject_id)) {
    throw new HttpError(400, "knowledge_owner_cannot_be_collaborator");
  }

  const current = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT * FROM knowledge_permissions
       WHERE namespace_id = ? AND object_id = ? AND subject_type = 'user' AND revoked_at IS NULL
       ORDER BY updated_at DESC, id DESC`
    )
    .bind(namespace.id, folder.id)
    .all<PermissionRow>();
  const currentRows = current.results ?? [];
  const previousCollaboratorUserIds = [...new Set(currentRows
    .filter((row) => permissionRoleForRow(row) === "collaborator")
    .map((row) => row.subject_id))].sort();
  const desiredPlaceholders = desiredUserIds.map(() => "?").join(", ");
  const excludeDesiredSql = desiredUserIds.length > 0
    ? `AND subject_id NOT IN (${desiredPlaceholders})`
    : "";
  const statements: D1PreparedStatement[] = [
    publicSharesCreatedByUnselectedCollaboratorsRevokeStatement(env, namespace.id, folder, desiredUserIds),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_permissions
         SET role = 'viewer', can_share = 0, can_publish_skill = 0,
             updated_at = CURRENT_TIMESTAMP
         WHERE namespace_id = ? AND object_id = ? AND subject_type = 'user'
           AND role IN ('editor', 'collaborator')
           AND revoked_at IS NULL
           ${excludeDesiredSql}
           AND EXISTS (
             SELECT 1
             FROM knowledge_permission_provenance AS provenance
             JOIN knowledge_services AS service
               ON service.id = provenance.source_id
              AND service.namespace_id = knowledge_permissions.namespace_id
              AND service.folder_object_id = knowledge_permissions.object_id
             WHERE provenance.permission_id = knowledge_permissions.id
               AND provenance.grant_source = 'knowledge_service'
               AND service.status = 'active'
               AND service.agent_enabled = 1
           )`
      )
      .bind(namespace.id, folder.id, ...desiredUserIds),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_permissions
         SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE namespace_id = ? AND object_id = ? AND subject_type = 'user'
           AND role IN ('editor', 'collaborator')
           AND revoked_at IS NULL
           ${excludeDesiredSql}`
      )
      .bind(namespace.id, folder.id, ...desiredUserIds)
  ];

  if (desiredUserIds.length > 0) {
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_permissions
           SET role = 'editor', can_share = 1, can_publish_skill = 0, expires_at = NULL,
               granted_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE namespace_id = ? AND object_id = ? AND subject_type = 'user'
             AND subject_id IN (${desiredPlaceholders})
             AND revoked_at IS NULL`
        )
        .bind(principal.sub, namespace.id, folder.id, ...desiredUserIds)
    );
  }
  for (const userId of desiredUserIds) {
    const permissionId = `kperm_${crypto.randomUUID()}`;
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_permissions (
             id, namespace_id, object_id, subject_type, subject_id, role,
             can_share, can_publish_skill, granted_by_user_id, expires_at
           )
           SELECT ?, ?, ?, 'user', ?, 'editor', 1, 0, ?, NULL
           WHERE NOT EXISTS (
             SELECT 1 FROM knowledge_permissions
             WHERE namespace_id = ? AND object_id = ? AND subject_type = 'user'
               AND subject_id = ? AND revoked_at IS NULL
           )`
        )
        .bind(
          permissionId,
          namespace.id,
          folder.id,
          userId,
          principal.sub,
          namespace.id,
          folder.id,
          userId
        ),
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_permission_provenance (
             permission_id, grant_source, source_id
           ) SELECT ?, 'direct', ?
           WHERE EXISTS (
             SELECT 1 FROM knowledge_permissions
             WHERE id = ? AND revoked_at IS NULL
           )
           ON CONFLICT(permission_id) DO UPDATE SET
             grant_source = 'direct',
             source_id = excluded.source_id,
             updated_at = CURRENT_TIMESTAMP`
        )
        .bind(permissionId, folder.id, permissionId)
    );
  }
  // All collaborator changes and removed-collaborator link revocations commit
  // together. D1 rolls the whole batch back if any statement fails.
  await env.KNOWLEDGE_DB.batch(statements);

  const saved = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT * FROM knowledge_permissions
       WHERE namespace_id = ? AND object_id = ? AND subject_type = 'user'
         AND role IN ('editor', 'collaborator')
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
       ORDER BY subject_id`
    )
    .bind(namespace.id, folder.id)
    .all<PermissionRow>();
  const collaborators = (saved.results ?? []).map(permissionJson);
  const savedUserIds = collaborators.map((grant) => grant.subjectId);
  const savedUserIdSet = new Set(savedUserIds);
  const removedUserIds = previousCollaboratorUserIds.filter((userId) => !savedUserIdSet.has(userId));
  await writeAuditEvent(env, {
    action: "knowledge.collaborators.replace",
    metadata: {
      collaboratorUserIds: savedUserIds,
      removedUserIds
    },
    namespace,
    objectId: folder.id,
    principal
  });
  return {
    collaborators,
    userIds: savedUserIds,
    removedUserIds,
    folder: await objectJsonForPrincipal(env, folder, principal)
  };
}
