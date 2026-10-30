import { writeAuditEvent } from "../audit/events.ts";
import { knowledgeV2Flags } from "../knowledge-v2-flags.ts";
import { parentPathsForPath } from "../paths.ts";
import type { CanonicalKnowledgeRole, Env, NamespaceRow, ObjectRow, PermissionRow, Principal } from "../types.ts";
import { permissionAppliesToPrincipal, permissionRoleForRow, roleRank } from "./policy.ts";

// Resolve effective object access, including ancestor grants, service grant state and break-glass audit.
export async function accessRoleForObject(
  env: Env,
  namespace: NamespaceRow,
  object: ObjectRow,
  principal: Principal
): Promise<CanonicalKnowledgeRole | "none"> {
  const role = await unrestrictedAccessRoleForObject(env, namespace, object, principal);
  return principal.folderEditOnly && role === "owner" ? "collaborator" : role;
}

async function unrestrictedAccessRoleForObject(
  env: Env,
  namespace: NamespaceRow,
  object: ObjectRow,
  principal: Principal
): Promise<CanonicalKnowledgeRole | "none"> {
  if (namespace.org_id !== principal.orgId) {
    return "none";
  }
  if (!knowledgeV2Flags(env).rootAcl && (namespace.owner_user_id === principal.sub || principal.role === "admin")) {
    return "owner";
  }
  if (knowledgeV2Flags(env).rootAcl && principal.role === "admin" && principal.breakGlassReason) {
    await writeAuditEvent(env, {
      action: "knowledge.break_glass.use",
      metadata: { reason: principal.breakGlassReason },
      namespace,
      objectId: object.id,
      principal
    });
    return "owner";
  }

  const rows = await permissionRowsForObject(env, namespace.id, object);
  let best: CanonicalKnowledgeRole | "none" = "none";
  for (const row of rows) {
    const permissionRole = permissionRoleForRow(row);
    if (
      knowledgeV2Flags(env).rootAcl
      && permissionRole === "viewer"
      && row.grant_source === "knowledge_service"
      && row.service_grant_active !== 1
    ) {
      continue;
    }
    if (permissionAppliesToPrincipal(row, principal) && roleRank(permissionRole) > roleRank(best)) {
      best = permissionRole;
    }
  }
  return best;
}

export async function permissionRowsForObject(env: Env, namespaceId: string, object: ObjectRow) {
  const objectIds = await objectAndAncestorIds(env, namespaceId, object);
  const placeholders = objectIds.map(() => "?").join(", ");
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT
        permission.*,
        provenance.grant_source,
        provenance.source_id,
        CASE WHEN provenance.grant_source = 'knowledge_service' AND EXISTS (
          SELECT 1
          FROM knowledge_services AS service
          WHERE service.id = provenance.source_id
            AND service.namespace_id = permission.namespace_id
            AND service.folder_object_id = permission.object_id
            AND service.status = 'active'
            AND service.agent_enabled = 1
        ) THEN 1 ELSE 0 END AS service_grant_active
      FROM knowledge_permissions AS permission
      LEFT JOIN knowledge_permission_provenance AS provenance
        ON provenance.permission_id = permission.id
      WHERE permission.namespace_id = ?
        AND permission.revoked_at IS NULL
        AND (permission.expires_at IS NULL OR datetime(permission.expires_at) > CURRENT_TIMESTAMP)
        AND (permission.object_id IS NULL OR permission.object_id IN (${placeholders}))
      ORDER BY permission.object_id IS NULL ASC, permission.created_at DESC
      `
    )
    .bind(namespaceId, ...objectIds)
    .all<PermissionRow>();
  return rows.results ?? [];
}

async function objectAndAncestorIds(env: Env, namespaceId: string, object: ObjectRow) {
  const paths = parentPathsForPath(object.path);
  const ids = new Set<string>([object.id]);
  if (paths.length === 0) {
    return [...ids];
  }
  const placeholders = paths.map(() => "?").join(", ");
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT id FROM knowledge_objects
      WHERE namespace_id = ? AND object_kind = 'folder' AND deleted_at IS NULL AND path IN (${placeholders})
      `
    )
    .bind(namespaceId, ...paths)
    .all<{ id: string }>();
  (rows.results ?? []).forEach((row) => ids.add(row.id));
  return [...ids];
}
