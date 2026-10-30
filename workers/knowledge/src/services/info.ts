import { accessRoleForObject } from "../access/authorization.ts";
import { canonicalPermissionRole, roleHasKnowledgeCapability } from "../access/policy.ts";
import { writeAuditEvent } from "../audit/events.ts";
import { HttpError } from "../http.ts";
import { requireNamespaceForPrincipal, requireObject } from "../objects/repository.ts";
import { objectJsonForPrincipal } from "../objects/representation.ts";
import type { Env, Principal } from "../types.ts";
import { isRecord } from "../values.ts";
import {
  knowledgeServiceProfileFromBody,
  knowledgeServiceProfileUpsertStatement,
  knowledgeServiceRoutingCardUpsertStatement,
  requireProfileText
} from "./profile.ts";
import { latestServiceVersion, requireKnowledgeService } from "./repository.ts";
import { knowledgeServiceJson } from "./representation.ts";

export async function updateKnowledgeServiceInfo(env: Env, principal: Principal, serviceId: string, body: Record<string, unknown>) {
  const row = await requireKnowledgeService(env, serviceId);
  if (row.status !== "active" || row.agent_enabled !== 1) {
    throw new HttpError(409, "knowledge_service_not_active");
  }
  const folder = await requireObject(env, row.folder_object_id);
  const namespace = await requireNamespaceForPrincipal(env, row.namespace_id, principal);
  const actorRole = canonicalPermissionRole(await accessRoleForObject(env, namespace, folder, principal));
  if (!roleHasKnowledgeCapability(actorRole, "updateServiceInfo")) {
    throw new HttpError(403, "knowledge_service_info_update_denied");
  }
  if (isRecord(body.info) && Object.keys(body).some((field) => field !== "info")) {
    throw new HttpError(400, "knowledge_service_info_field_not_allowed");
  }
  const info = isRecord(body.info) ? body.info : body;
  const allowedFields = new Set(["description", "role", "bestFor", "notFor", "keywords", "searchHints"]);
  const fields = Object.keys(info);
  if (fields.length === 0) {
    throw new HttpError(400, "knowledge_service_info_required");
  }
  if (fields.some((field) => !allowedFields.has(field))) {
    throw new HttpError(400, "knowledge_service_info_field_not_allowed");
  }
  const description = Object.prototype.hasOwnProperty.call(info, "description")
    ? requireProfileText(info.description, "knowledge_service_description_invalid", 1_000)
    : row.description;
  const profile = knowledgeServiceProfileFromBody({ profile: info }, row);
  await env.KNOWLEDGE_DB.batch([
    env.KNOWLEDGE_DB.prepare(
      `UPDATE knowledge_services
       SET description = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(description, row.id),
    knowledgeServiceProfileUpsertStatement(env, row.id, profile),
    knowledgeServiceRoutingCardUpsertStatement(env, row.id, profile)
  ]);
  const updated = await requireKnowledgeService(env, row.id);
  await writeAuditEvent(env, {
    action: "knowledge.service.info.update",
    metadata: { profile, serviceId: row.id },
    namespace,
    objectId: folder.id,
    principal
  });
  return {
    service: knowledgeServiceJson(updated, await latestServiceVersion(env, row.id), actorRole),
    folder: await objectJsonForPrincipal(env, folder, principal)
  };
}
