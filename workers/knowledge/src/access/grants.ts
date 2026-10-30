import { writeAuditEvent } from "../audit/events.ts";
import { HttpError } from "../http.ts";
import { namespaceJson } from "../namespaces/representation.ts";
import { isKnowledgeServiceHandbookObject } from "../objects/access.ts";
import { requireNamespaceForPrincipal, requireObject } from "../objects/repository.ts";
import { activeKnowledgeServiceForObject, objectJsonForPrincipal } from "../objects/representation.ts";
import { publicSharesCreatedByUsersRevokeStatement } from "../shares/revocation.ts";
import type { Env, NamespaceRow, ObjectRow, PermissionRow, Principal } from "../types.ts";
import { readOptionalString, readString } from "../values.ts";
import { accessRoleForObject } from "./authorization.ts";
import {
  canonicalPermissionRole,
  knowledgeCapabilities,
  permissionRoleForRow,
  roleHasKnowledgeCapability,
  roleRank,
  storagePermissionRole,
  validatePermissionRole,
  validateSubjectId,
  validateSubjectType
} from "./policy.ts";
import { permissionJson } from "./representation.ts";

export async function listAccess(env: Env, principal: Principal, objectId: string, namespaceId: string) {
  let namespace: NamespaceRow;
  let object: ObjectRow | undefined;

  if (objectId) {
    object = await requireObject(env, objectId);
    namespace = await requireNamespaceForPrincipal(env, object.namespace_id, principal);
    const role = await accessRoleForObject(env, namespace, object, principal);
    if (roleRank(role) < roleRank("viewer")) {
      throw new HttpError(403, "knowledge_access_denied");
    }
  } else if (namespaceId) {
    namespace = await requireNamespaceForPrincipal(env, namespaceId, principal);
    if (namespace.owner_user_id !== principal.sub && principal.role !== "admin") {
      throw new HttpError(403, "knowledge_access_denied");
    }
  } else {
    throw new HttpError(400, "missing_access_target");
  }

  const effectiveRole = object
    ? await accessRoleForObject(env, namespace, object, principal)
    : namespace.owner_user_id === principal.sub || principal.role === "admin" ? "owner" : "none";
  const canManageAccess = roleHasKnowledgeCapability(effectiveRole, "manageAccess");
  const agentEnabled = object ? Boolean(await activeKnowledgeServiceForObject(env, object)) : false;
  const protectedHandbook = object?.object_kind === "file" && await isKnowledgeServiceHandbookObject(env, object.id);
  const rows = canManageAccess
    ? await env.KNOWLEDGE_DB
      .prepare(
        `
        SELECT * FROM knowledge_permissions
        WHERE namespace_id = ?
          AND (? = '' OR object_id = ? OR object_id IS NULL)
          AND revoked_at IS NULL
        ORDER BY created_at DESC
        LIMIT 100
        `
      )
      .bind(namespace.id, object?.id ?? "", object?.id ?? "")
      .all<PermissionRow>()
    : { results: [] as PermissionRow[] };
  return {
    namespace: namespaceJson(namespace),
    object: object ? await objectJsonForPrincipal(env, object, principal) : undefined,
    effectiveRole: canonicalPermissionRole(effectiveRole),
    capabilities: knowledgeCapabilities(
      canonicalPermissionRole(effectiveRole),
      agentEnabled,
      object?.object_kind,
      protectedHandbook,
      object?.object_kind === "folder" && !object.parent_path
    ),
    grants: (rows.results ?? []).map(permissionJson)
  };
}

export async function createAccessGrant(env: Env, principal: Principal, body: Record<string, unknown>) {
  const objectId = readString(body.objectId ?? body.object_id);
  const namespaceId = readString(body.namespaceId ?? body.namespace_id);
  const subjectType = validateSubjectType(body.subjectType ?? body.subject_type);
  const role = validatePermissionRole(body.role);
  const storageRole = storagePermissionRole(role);
  const canShare = role === "collaborator" ? 1 : 0;
  const expiresAt = readOptionalString(body.expiresAt ?? body.expires_at) ?? null;
  let namespace: NamespaceRow;
  let targetObjectId: string | null = null;
  let targetObject: ObjectRow | undefined;

  if (objectId) {
    const object = await requireObject(env, objectId);
    namespace = await requireNamespaceForPrincipal(env, object.namespace_id, principal);
    if (object.object_kind !== "folder") {
      throw new HttpError(400, "knowledge_access_target_not_folder");
    }
    if (object.parent_path) {
      throw new HttpError(400, "knowledge_acl_root_required");
    }
    const actorRole = await accessRoleForObject(env, namespace, object, principal);
    if (!roleHasKnowledgeCapability(actorRole, "manageAccess")) {
      throw new HttpError(403, "knowledge_share_denied");
    }
    targetObjectId = object.id;
    targetObject = object;
  } else if (namespaceId) {
    await requireNamespaceForPrincipal(env, namespaceId, principal);
    throw new HttpError(400, "knowledge_acl_root_required");
  } else {
    throw new HttpError(400, "missing_access_target");
  }

  const subjectId = validateSubjectId(body.subjectId ?? body.subject_id, subjectType, namespace.org_id);
  if (role === "collaborator" && subjectType !== "user") {
    throw new HttpError(400, "knowledge_collaborator_subject_must_be_user");
  }
  const id = `kperm_${crypto.randomUUID()}`;
  const existing = await env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT * FROM knowledge_permissions
      WHERE namespace_id = ?
        AND IFNULL(object_id, '') = IFNULL(?, '')
        AND subject_type = ?
        AND subject_id = ?
        AND revoked_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
      `
    )
    .bind(namespace.id, targetObjectId, subjectType, subjectId)
    .first<PermissionRow>();

  if (existing) {
    if (permissionRoleForRow(existing) === "owner") {
      throw new HttpError(409, "knowledge_owner_requires_transfer");
    }
    const statements: D1PreparedStatement[] = [
      env.KNOWLEDGE_DB
        .prepare(
          `
          UPDATE knowledge_permissions
          SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE namespace_id = ?
            AND IFNULL(object_id, '') = IFNULL(?, '')
            AND subject_type = ?
            AND subject_id = ?
            AND revoked_at IS NULL
            AND id != ?
          `
        )
        .bind(namespace.id, targetObjectId, subjectType, subjectId, existing.id),
      env.KNOWLEDGE_DB
        .prepare(
          `
          UPDATE knowledge_permissions
          SET role = ?, can_share = ?, can_publish_skill = 0, expires_at = ?, granted_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `
        )
        .bind(storageRole, canShare, expiresAt, principal.sub, existing.id),
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_permission_provenance (
             permission_id, grant_source, source_id
           ) VALUES (?, 'direct', ?)
           ON CONFLICT(permission_id) DO UPDATE SET
             grant_source = 'direct',
             source_id = excluded.source_id,
             updated_at = CURRENT_TIMESTAMP`
        )
        .bind(existing.id, targetObjectId ?? "")
    ];
    if (targetObject && permissionRoleForRow(existing) === "collaborator" && role !== "collaborator") {
      statements.push(publicSharesCreatedByUsersRevokeStatement(env, namespace.id, targetObject, [subjectId]));
    }
    await env.KNOWLEDGE_DB.batch(statements);
  } else {
    await env.KNOWLEDGE_DB.batch([
      env.KNOWLEDGE_DB
        .prepare(
          `
          INSERT INTO knowledge_permissions (
            id, namespace_id, object_id, subject_type, subject_id, role, can_share, can_publish_skill, granted_by_user_id, expires_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .bind(id, namespace.id, targetObjectId, subjectType, subjectId, storageRole, canShare, 0, principal.sub, expiresAt),
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_permission_provenance (
             permission_id, grant_source, source_id
           ) VALUES (?, 'direct', ?)`
        )
        .bind(id, targetObjectId ?? "")
    ]);
  }

  const grant = await env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT * FROM knowledge_permissions
      WHERE namespace_id = ? AND IFNULL(object_id, '') = IFNULL(?, '') AND subject_type = ? AND subject_id = ? AND revoked_at IS NULL
      LIMIT 1
      `
    )
    .bind(namespace.id, targetObjectId, subjectType, subjectId)
    .first<PermissionRow>();
  if (!grant) {
    throw new HttpError(500, "knowledge_grant_create_failed");
  }
  await writeAuditEvent(env, {
    action: "knowledge.access_grant.upsert",
    metadata: { grantId: grant.id, role, subjectId, subjectType },
    namespace,
    objectId: targetObjectId,
    principal
  });
  return grant;
}

export async function revokeAccessGrant(env: Env, principal: Principal, grantId: string) {
  const grant = await env.KNOWLEDGE_DB
    .prepare("SELECT * FROM knowledge_permissions WHERE id = ? AND revoked_at IS NULL LIMIT 1")
    .bind(grantId)
    .first<PermissionRow>();
  if (!grant) {
    throw new HttpError(404, "knowledge_access_grant_not_found");
  }
  const namespace = await requireNamespaceForPrincipal(env, grant.namespace_id, principal);
  const targetObject = grant.object_id ? await requireObject(env, grant.object_id) : undefined;
  const actorRole = targetObject
    ? await accessRoleForObject(env, namespace, targetObject, principal)
    : "none";
  if (!roleHasKnowledgeCapability(actorRole, "manageAccess")) {
    throw new HttpError(403, "knowledge_share_denied");
  }
  if (permissionRoleForRow(grant) === "owner") {
    throw new HttpError(409, "knowledge_owner_requires_transfer");
  }

  const statements: D1PreparedStatement[] = [
    env.KNOWLEDGE_DB
      .prepare("UPDATE knowledge_permissions SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL")
      .bind(grant.id)
  ];
  if (targetObject && permissionRoleForRow(grant) === "collaborator") {
    statements.push(publicSharesCreatedByUsersRevokeStatement(env, namespace.id, targetObject, [grant.subject_id]));
  }
  // Access and public links must be revoked together, including on storage failure.
  await env.KNOWLEDGE_DB.batch(statements);
  const grantRole = permissionRoleForRow(grant);
  await writeAuditEvent(env, {
    action: "knowledge.access_grant.revoke",
    metadata: { grantId: grant.id, role: grantRole, subjectId: grant.subject_id, subjectType: grant.subject_type },
    namespace,
    objectId: grant.object_id,
    principal
  });
  return { revoked: true, grant: permissionJson({ ...grant, revoked_at: new Date().toISOString() }) };
}
