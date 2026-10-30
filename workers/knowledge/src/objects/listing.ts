import type { Env, ObjectRow, Principal } from "../types.ts";
import { principalSubjectPairs } from "../access/policy.ts";
import { objectJsonListForPrincipal } from "./representation.ts";

export async function listObjects(env: Env, namespaceId: string, parentPath: string, orgId: string) {
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT
        knowledge_objects.*,
        EXISTS (
          SELECT 1
          FROM knowledge_services
          WHERE knowledge_services.folder_object_id = knowledge_objects.id
            AND knowledge_services.status = 'active'
            AND knowledge_services.agent_enabled = 1
          LIMIT 1
        ) AS agent_enabled,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM knowledge_shares
            WHERE knowledge_shares.object_id = knowledge_objects.id
              AND knowledge_shares.visibility = 'public'
              AND knowledge_shares.revoked_at IS NULL
              AND (knowledge_shares.expires_at IS NULL OR datetime(knowledge_shares.expires_at) > CURRENT_TIMESTAMP)
            LIMIT 1
          ) THEN 'public'
          WHEN EXISTS (
            SELECT 1
            FROM knowledge_permissions
            WHERE knowledge_permissions.object_id = knowledge_objects.id
              AND knowledge_permissions.subject_type = 'company'
              AND knowledge_permissions.subject_id = ?
              AND knowledge_permissions.revoked_at IS NULL
              AND (knowledge_permissions.expires_at IS NULL OR datetime(knowledge_permissions.expires_at) > CURRENT_TIMESTAMP)
            LIMIT 1
          ) THEN 'company'
          ELSE 'private'
        END AS share_mode
      FROM knowledge_objects
      WHERE knowledge_objects.namespace_id = ? AND knowledge_objects.parent_path = ? AND knowledge_objects.deleted_at IS NULL
      ORDER BY object_kind = 'folder' DESC, lower(file_name) ASC
      LIMIT 500
      `
    )
    .bind(orgId, namespaceId, parentPath)
    .all<ObjectRow>();
  return rows.results ?? [];
}

export async function listSharedWithMe(env: Env, principal: Principal) {
  const subjects = principalSubjectPairs(principal);
  if (subjects.length === 0) {
    return [];
  }
  const where = subjects.map(() => "(knowledge_permissions.subject_type = ? AND knowledge_permissions.subject_id = ?)").join(" OR ");
  const binds = subjects.flatMap((subject) => [subject.type, subject.id]);
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT DISTINCT knowledge_objects.*
      FROM knowledge_permissions
      JOIN knowledge_objects ON knowledge_objects.id = knowledge_permissions.object_id
      JOIN knowledge_namespaces ON knowledge_namespaces.id = knowledge_objects.namespace_id
      WHERE (${where})
        AND knowledge_permissions.revoked_at IS NULL
        AND (knowledge_permissions.expires_at IS NULL OR datetime(knowledge_permissions.expires_at) > CURRENT_TIMESTAMP)
        AND knowledge_objects.deleted_at IS NULL
        AND knowledge_namespaces.org_id = ?
        AND knowledge_namespaces.owner_user_id != ?
      ORDER BY knowledge_objects.updated_at DESC
      LIMIT 100
      `
    )
    .bind(...binds, principal.orgId, principal.sub)
    .all<ObjectRow>();
  const items = await objectJsonListForPrincipal(env, rows.results ?? [], principal);
  return items.filter((item) => item.capabilities.canRead);
}
