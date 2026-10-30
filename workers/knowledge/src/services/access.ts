import { accessRoleForObject } from "../access/authorization.ts";
import { canonicalPermissionRole, roleRank } from "../access/policy.ts";
import { HttpError } from "../http.ts";
import { requireNamespaceForPrincipal, requireObject } from "../objects/repository.ts";
import type { Env, Principal } from "../types.ts";
import { requireKnowledgeService } from "./repository.ts";

// Check service lifecycle, organization and folder ACL before serving a query.
export async function requireReadableKnowledgeService(env: Env, principal: Principal, serviceId: string) {
  const row = await requireKnowledgeService(env, serviceId);
  if (row.status !== "active" || row.agent_enabled !== 1) {
    throw new HttpError(404, "knowledge_service_not_found");
  }
  const folder = await requireObject(env, row.folder_object_id);
  const namespace = await requireNamespaceForPrincipal(env, row.namespace_id, principal);
  const role = await accessRoleForObject(env, namespace, folder, principal);
  if (roleRank(role) < roleRank("viewer")) {
    throw new HttpError(403, "knowledge_service_access_denied");
  }
  return { row, folder, namespace, effectiveRole: canonicalPermissionRole(role) };
}
