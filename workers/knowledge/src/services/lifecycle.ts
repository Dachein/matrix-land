import { accessRoleForObject } from "../access/authorization.ts";
import { canonicalPermissionRole, roleHasKnowledgeCapability } from "../access/policy.ts";
import { writeAuditEvent } from "../audit/events.ts";
import { HttpError } from "../http.ts";
import { reindexKnowledgeService } from "../indexing/reindex.ts";
import { requireNamespaceForPrincipal, requireObject } from "../objects/repository.ts";
import { objectJsonForPrincipal } from "../objects/representation.ts";
import { countActivePublicSharesForObject } from "../shares/repository.ts";
import type { Env, KnowledgeServiceRow, Principal } from "../types.ts";
import { readBoolean, readOptionalString, slugPart } from "../values.ts";
import { folderFromKnowledgeServicePublishBody, requireExistingHandbookMarkdown } from "./preflight.ts";
import {
  knowledgeServiceProfileFromBody,
  knowledgeServiceProfileUpsertStatement,
  knowledgeServiceRoutingCardUpsertStatement
} from "./profile.ts";
import { latestServiceVersion, requireKnowledgeService } from "./repository.ts";
import { knowledgeServiceJson, knowledgeServiceVersionJson } from "./representation.ts";
import {
  assertKnowledgeServiceViewerPolicyCanBeRepresented,
  knowledgeServiceAccessMutationStatements,
  parseKnowledgeServiceAccessSettings,
  readKnowledgeServiceAccessSettings,
  serviceViewerGrantRevokeStatements
} from "./viewerAcl.ts";

export async function publishKnowledgeService(env: Env, principal: Principal, body: Record<string, unknown>) {
  const folder = await folderFromKnowledgeServicePublishBody(env, principal, body);
  const namespace = await requireNamespaceForPrincipal(env, folder.namespace_id, principal);
  const actorRole = canonicalPermissionRole(await accessRoleForObject(env, namespace, folder, principal));
  if (folder.parent_path) {
    throw new HttpError(400, "knowledge_service_root_required");
  }
  if (!roleHasKnowledgeCapability(actorRole, "manageService")) {
    throw new HttpError(403, "knowledge_service_publish_denied");
  }

  const name = readOptionalString(body.name) ?? (folder.title || folder.file_name);
  const description = readOptionalString(body.description) ?? `Read-only Knowledge Service for ${name}.`;
  const requestedAccess = parseKnowledgeServiceAccessSettings(body.access, namespace.org_id);
  if (requestedAccess) {
    await assertKnowledgeServiceViewerPolicyCanBeRepresented(env, namespace, folder, requestedAccess);
  }
  const handbook = await requireExistingHandbookMarkdown(env, namespace, folder);
  const handbookPublicSharesRevoked = await countActivePublicSharesForObject(env, handbook.id);

  const slug = slugPart(`${name}-${folder.id}`).slice(0, 96);
  const existing = await env.KNOWLEDGE_DB
    .prepare("SELECT * FROM knowledge_services WHERE namespace_id = ? AND folder_object_id = ? LIMIT 1")
    .bind(namespace.id, folder.id)
    .first<KnowledgeServiceRow>();
  const serviceId = existing?.id ?? `ksvc_${crypto.randomUUID()}`;
  const currentProfile = existing ? await requireKnowledgeService(env, existing.id) : undefined;
  const profile = knowledgeServiceProfileFromBody(body, currentProfile);
  const statements: D1PreparedStatement[] = [
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_shares
         SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE object_id = ? AND visibility = 'public' AND revoked_at IS NULL`
      )
      .bind(handbook.id)
  ];

  if (existing) {
    statements.push(
      env.KNOWLEDGE_DB.prepare(
        `
        UPDATE knowledge_services
        SET handbook_object_id = ?, name = ?, slug = ?, description = ?, status = 'active',
            visibility = 'private', access_targets_json = '[]', update_mode = 'auto', agent_enabled = 1,
            index_status = 'queued', last_error = '', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `
      )
      .bind(handbook.id, name, slug, description, existing.id)
    );
  } else {
    statements.push(
      env.KNOWLEDGE_DB.prepare(
        `
        INSERT INTO knowledge_services (
          id, namespace_id, folder_object_id, handbook_object_id, name, slug, description, status,
          visibility, access_targets_json, update_mode, agent_enabled, index_status, created_by_user_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'private', '[]', 'auto', 1, 'queued', ?)
        `
      )
      .bind(serviceId, namespace.id, folder.id, handbook.id, name, slug, description, principal.sub)
    );
  }
  statements.push(
    knowledgeServiceProfileUpsertStatement(env, serviceId, profile),
    knowledgeServiceRoutingCardUpsertStatement(env, serviceId, profile)
  );
  if (requestedAccess) {
    statements.push(...knowledgeServiceAccessMutationStatements(
      env,
      namespace,
      folder,
      principal,
      requestedAccess,
      serviceId
    ));
  }
  // D1 batch is atomic: the service cannot be enabled with only part of the
  // requested Viewer ACL applied.
  await env.KNOWLEDGE_DB.batch(statements);

  const indexed = await reindexKnowledgeService(env, await requireKnowledgeService(env, serviceId), principal.sub);
  const serviceRow = indexed.service;
  const version = indexed.version;
  const access = await readKnowledgeServiceAccessSettings(env, namespace, folder, serviceId);
  const service = knowledgeServiceJson(serviceRow, version, actorRole, access);
  await writeAuditEvent(env, {
    action: existing ? "knowledge.service.enable" : "knowledge.service.create",
    metadata: {
      accessUpdated: Boolean(requestedAccess),
      access,
      handbookObjectId: handbook.id,
      handbookPublicSharesRevoked,
      profile,
      serviceId: serviceRow.id
    },
    namespace,
    objectId: folder.id,
    principal
  });
  return {
    service,
    version: knowledgeServiceVersionJson(version),
    folder: await objectJsonForPrincipal(env, folder, principal),
    handbook: await objectJsonForPrincipal(env, handbook, principal)
  };
}

export async function updateKnowledgeService(env: Env, principal: Principal, serviceId: string, body: Record<string, unknown>) {
  let row = await requireKnowledgeService(env, serviceId);
  const folder = await requireObject(env, row.folder_object_id);
  const namespace = await requireNamespaceForPrincipal(env, row.namespace_id, principal);
  const actorRole = canonicalPermissionRole(await accessRoleForObject(env, namespace, folder, principal));
  if (!roleHasKnowledgeCapability(actorRole, "manageService")) {
    throw new HttpError(403, "knowledge_service_manage_denied");
  }
  if (Object.prototype.hasOwnProperty.call(body, "handbookContent") || Object.prototype.hasOwnProperty.call(body, "handbook_content")) {
    throw new HttpError(400, "knowledge_service_handbook_content_edit_not_supported");
  }

  const wasAgentEnabled = row.status === "active" && row.agent_enabled === 1;
  const hasAgentEnabled = Object.prototype.hasOwnProperty.call(body, "agentEnabled") || Object.prototype.hasOwnProperty.call(body, "agent_enabled");
  const agentEnabled = hasAgentEnabled ? readBoolean(body.agentEnabled ?? body.agent_enabled) : row.agent_enabled === 1;
  const name = readOptionalString(body.name) ?? row.name;
  const description = readOptionalString(body.description) ?? row.description;
  const metadataChanged = name !== row.name || description !== row.description;
  const profile = knowledgeServiceProfileFromBody(body, row);
  const requestedAccess = parseKnowledgeServiceAccessSettings(body.access, namespace.org_id);
  if (!agentEnabled && requestedAccess) {
    throw new HttpError(400, "knowledge_service_access_requires_agent_enabled");
  }
  if (requestedAccess) {
    await assertKnowledgeServiceViewerPolicyCanBeRepresented(env, namespace, folder, requestedAccess);
  }
  const handbook = agentEnabled
    ? await requireExistingHandbookMarkdown(env, namespace, folder)
    : await requireObject(env, row.handbook_object_id).catch(() => undefined);
  const handbookObjectId = handbook?.id ?? row.handbook_object_id;
  const handbookPublicSharesRevoked = handbook && agentEnabled ? await countActivePublicSharesForObject(env, handbook.id) : 0;

  const statements: D1PreparedStatement[] = [
    env.KNOWLEDGE_DB.prepare(
      `
      UPDATE knowledge_services
      SET handbook_object_id = ?, name = ?, description = ?, status = ?, agent_enabled = ?,
          visibility = CASE WHEN ? = 1 THEN 'private' ELSE visibility END,
          access_targets_json = CASE WHEN ? = 1 THEN '[]' ELSE access_targets_json END,
          index_status = CASE WHEN ? = 1 THEN CASE WHEN index_status = 'disabled' THEN 'queued' ELSE index_status END ELSE 'disabled' END,
          last_error = CASE WHEN ? = 1 THEN last_error ELSE '' END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `
    )
    .bind(
      handbookObjectId,
      name,
      description,
      agentEnabled ? "active" : "draft",
      agentEnabled ? 1 : 0,
      agentEnabled ? 1 : 0,
      agentEnabled ? 1 : 0,
      agentEnabled ? 1 : 0,
      agentEnabled ? 1 : 0,
      row.id
    )
  ];
  statements.push(
    knowledgeServiceProfileUpsertStatement(env, row.id, profile),
    knowledgeServiceRoutingCardUpsertStatement(env, row.id, profile)
  );
  if (!agentEnabled) {
    statements.push(
      ...serviceViewerGrantRevokeStatements(env, row.id),
      env.KNOWLEDGE_DB
        .prepare("DELETE FROM knowledge_index_documents WHERE service_id = ?")
        .bind(row.id),
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_service_index_state (
             service_id, source_revision, indexed_revision, index_generation, status,
             pending_object_count, skipped_object_count, blocked_object_count,
             last_error, indexed_at, updated_at
           ) VALUES (?, ?, 0, ?, 'disabled', 0, 0, 0, '', NULL, CURRENT_TIMESTAMP)
           ON CONFLICT(service_id) DO UPDATE SET
             source_revision = excluded.source_revision,
             indexed_revision = 0,
             index_generation = excluded.index_generation,
             status = 'disabled',
             pending_object_count = 0,
             skipped_object_count = 0,
             blocked_object_count = 0,
             last_error = '',
             indexed_at = NULL,
             updated_at = CURRENT_TIMESTAMP`
        )
        .bind(row.id, row.source_revision, row.index_generation),
      env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_index_outbox
           SET status = 'superseded', last_error = '', updated_at = CURRENT_TIMESTAMP
           WHERE service_id = ?
             AND status IN ('pending', 'dispatching', 'dispatched', 'failed')`
        )
        .bind(row.id)
    );
  }
  if (handbook && agentEnabled) {
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_shares
           SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE object_id = ? AND visibility = 'public' AND revoked_at IS NULL`
        )
        .bind(handbook.id)
    );
  }
  if (requestedAccess) {
    statements.push(...knowledgeServiceAccessMutationStatements(
      env,
      namespace,
      folder,
      principal,
      requestedAccess,
      row.id
    ));
  }
  await env.KNOWLEDGE_DB.batch(statements);

  row = await requireKnowledgeService(env, row.id);
  let version = await latestServiceVersion(env, row.id);
  if (agentEnabled && (readBoolean(body.reindex) || row.index_status !== "ready" || metadataChanged)) {
    const indexed = await reindexKnowledgeService(env, row, principal.sub);
    row = indexed.service;
    version = indexed.version;
  }
  const access = await readKnowledgeServiceAccessSettings(env, namespace, folder, row.id);
  await writeAuditEvent(env, {
    action: !agentEnabled ? "knowledge.service.disable" : wasAgentEnabled ? "knowledge.service.update" : "knowledge.service.enable",
    metadata: {
      agentEnabled,
      access,
      accessUpdated: Boolean(requestedAccess),
      handbookPublicSharesRevoked,
      profile,
      reindexRequested: readBoolean(body.reindex),
      serviceId: row.id
    },
    namespace,
    objectId: folder.id,
    principal
  });
  return {
    service: knowledgeServiceJson(row, version, actorRole, access),
    folder: await objectJsonForPrincipal(env, folder, principal),
    handbook: handbook ? await objectJsonForPrincipal(env, handbook, principal) : undefined
  };
}
