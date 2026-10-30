import type { Env, ObjectRow } from "../types.ts";

export function publicSharesCreatedByUnselectedCollaboratorsRevokeStatement(
  env: Env,
  namespaceId: string,
  targetObject: ObjectRow,
  desiredUserIds: string[]
) {
  const desiredPlaceholders = desiredUserIds.map(() => "?").join(", ");
  const excludeDesiredSql = desiredUserIds.length > 0
    ? `AND subject_id NOT IN (${desiredPlaceholders})`
    : "";
  return env.KNOWLEDGE_DB
    .prepare(
      `UPDATE knowledge_shares
       SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
       WHERE namespace_id = ?
         AND created_by_user_id IN (
           SELECT subject_id FROM knowledge_permissions
           WHERE namespace_id = ? AND object_id = ? AND subject_type = 'user'
             AND role IN ('editor', 'collaborator')
             AND revoked_at IS NULL
             ${excludeDesiredSql}
         )
         AND visibility = 'public'
         AND revoked_at IS NULL
         AND object_id IN (
           SELECT id FROM knowledge_objects
           WHERE namespace_id = ?
             AND (
               id = ?
               OR substr(path, 1, length(?) + 1) = ? || '/'
             )
         )`
    )
    .bind(
      namespaceId,
      namespaceId,
      targetObject.id,
      ...desiredUserIds,
      namespaceId,
      targetObject.id,
      targetObject.path,
      targetObject.path
    );
}

export function publicSharesCreatedByUsersRevokeStatement(
  env: Env,
  namespaceId: string,
  targetObject: ObjectRow,
  userIds: string[]
) {
  const placeholders = userIds.map(() => "?").join(", ");
  return env.KNOWLEDGE_DB
    .prepare(
      `UPDATE knowledge_shares
       SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
       WHERE namespace_id = ?
         AND created_by_user_id IN (${placeholders})
         AND visibility = 'public'
         AND revoked_at IS NULL
         AND object_id IN (
           SELECT id FROM knowledge_objects
           WHERE namespace_id = ?
             AND (
               id = ?
               OR substr(path, 1, length(?) + 1) = ? || '/'
             )
         )`
    )
    .bind(namespaceId, ...userIds, namespaceId, targetObject.id, targetObject.path, targetObject.path);
}
