import { accessRoleForObject } from "../access/authorization.ts";
import { canonicalPermissionRole, roleHasKnowledgeCapability, roleRank } from "../access/policy.ts";
import { HttpError } from "../http.ts";
import type { KnowledgeCapability } from "../knowledge-capabilities.ts";
import type { Env, NamespaceRow, ObjectRow, PermissionRow, Principal } from "../types.ts";
import { requireNamespaceForPrincipal, requireObject } from "./repository.ts";

export async function requireReadableObject(env: Env, principal: Principal, objectId: string) {
  const object = await requireObject(env, objectId);
  const namespace = await requireNamespaceForPrincipal(env, object.namespace_id, principal);
  const role = await accessRoleForObject(env, namespace, object, principal);
  if (roleRank(role) >= roleRank("viewer")) {
    return object;
  }
  throw new HttpError(403, "knowledge_access_denied");
}

export async function requireWritableObject(env: Env, principal: Principal, objectId: string) {
  const object = await requireObject(env, objectId);
  const namespace = await requireNamespaceForPrincipal(env, object.namespace_id, principal);
  const role = await accessRoleForObject(env, namespace, object, principal);
  if (roleHasKnowledgeCapability(role, "editContent")) {
    return object;
  }
  throw new HttpError(403, "knowledge_write_denied");
}

export async function assertObjectMutationAllowed(
  env: Env,
  namespace: NamespaceRow,
  object: ObjectRow,
  principal: Principal,
  operation: "content" | "delete" | "structure"
) {
  const role = canonicalPermissionRole(await accessRoleForObject(env, namespace, object, principal));
  if (
    operation !== "content"
    && object.object_kind === "folder"
    && !object.parent_path
    && !roleHasKnowledgeCapability(role, "manageProtectedStructure")
  ) {
    throw new HttpError(403, "knowledge_root_structure_manage_denied");
  }
  const protectedService = await env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT knowledge_services.id, knowledge_services.status, knowledge_services.agent_enabled,
             knowledge_services.folder_object_id, knowledge_services.handbook_object_id,
             service_folder.path AS service_folder_path
      FROM knowledge_services
      JOIN knowledge_objects AS service_folder ON service_folder.id = knowledge_services.folder_object_id
      WHERE knowledge_services.namespace_id = ?
        AND knowledge_services.status != 'archived'
        AND (
          knowledge_services.handbook_object_id = ?
          OR knowledge_services.folder_object_id = ?
          OR service_folder.path = ?
          OR substr(?, 1, length(service_folder.path) + 1) = service_folder.path || '/'
          OR (
            ? = 'folder'
            AND substr(service_folder.path, 1, length(?) + 1) = ? || '/'
          )
        )
      ORDER BY length(service_folder.path) ASC
      LIMIT 1
      `
    )
    .bind(
      object.namespace_id,
      object.id,
      object.id,
      object.path,
      object.path,
      object.object_kind,
      object.path,
      object.path
    )
    .first<{
      id: string;
      status: string;
      agent_enabled: number;
      folder_object_id: string;
      handbook_object_id: string;
      service_folder_path: string;
    }>();
  if (!protectedService) return;
  const protectedControlObject = object.id === protectedService.folder_object_id
    || object.id === protectedService.handbook_object_id;
  const requiredCapability: KnowledgeCapability = operation !== "content" && protectedControlObject
    ? "manageProtectedStructure"
    : "editContent";
  if (!roleHasKnowledgeCapability(role, requiredCapability)) {
    throw new HttpError(403, "knowledge_service_control_object_manage_denied");
  }
  if (
    operation !== "content"
    && protectedControlObject
    && protectedService.status === "active"
    && protectedService.agent_enabled === 1
  ) {
    throw new HttpError(409, "knowledge_service_disable_before_structure_change");
  }
}

export async function isKnowledgeServiceHandbookObject(env: Env, objectId: string) {
  const row = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT id
       FROM knowledge_services
       WHERE handbook_object_id = ? AND status != 'archived'
       LIMIT 1`
    )
    .bind(objectId)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function activeRootOwnerGrant(env: Env, rootObjectId: string) {
  return env.KNOWLEDGE_DB
    .prepare(
      `SELECT *
       FROM knowledge_permissions
       WHERE object_id = ?
         AND subject_type = 'user'
         AND role = 'owner'
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
       LIMIT 1`
    )
    .bind(rootObjectId)
    .first<PermissionRow>();
}
