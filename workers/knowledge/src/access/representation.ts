import type { PermissionRow } from "../types.ts";
import { permissionRoleForRow } from "./policy.ts";

export function permissionJson(row: PermissionRow) {
  const role = permissionRoleForRow(row);
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    objectId: row.object_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    role,
    canShare: role === "collaborator",
    canPublishSkill: false,
    grantedByUserId: row.granted_by_user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
