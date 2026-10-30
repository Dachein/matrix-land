import { sqliteTextLength } from "../sql.ts";
import { accessRoleForObject } from "../access/authorization.ts";
import { roleHasKnowledgeCapability } from "../access/policy.ts";
import { processKnowledgeDiffOutboxAfterMutation } from "../audit/diffs.ts";
import { HttpError } from "../http.ts";
import { dispatchKnowledgeIndexOutboxAfterMutation } from "../indexing/outbox.ts";
import { knowledgeV2Flags } from "../knowledge-v2-flags.ts";
import { activeRootOwnerGrant } from "../objects/access.ts";
import { contentKindFromMime, contentTypeFromName, sha256Hex, sha256Text } from "../objects/content.ts";
import { objectByPath, requireDeletedObject, requireNamespaceForPrincipal, requireObject, requireVersion } from "../objects/repository.ts";
import { persistObjectVersion } from "../objects/versions.ts";
import { normalizePath, parentPathFromPath } from "../paths.ts";
import { queueKnowledgeServicesForChangedPath } from "../services/invalidation.ts";
import type { Env, KnowledgeMutationContext, NamespaceRow, ObjectRow, PermissionRow, Principal } from "../types.ts";
import { readString, safeJsonRecord } from "../values.ts";
import {
  assertCommittedMutationReplay,
  assertExpectedVersionForMutation,
  changeAuditStatements,
  commitMetadataMutationStatement,
  existingMutationCommand
} from "./commands.ts";

export async function restoreObjectVersion(
  env: Env,
  namespace: NamespaceRow,
  object: ObjectRow,
  principal: Principal,
  targetVersionId: string,
  mutation: KnowledgeMutationContext
) {
  if (object.object_kind !== "file") {
    throw new HttpError(400, "knowledge_version_target_not_file");
  }
  assertExpectedVersionForMutation(object, mutation);
  const targetVersion = await requireVersion(env, targetVersionId);
  if (targetVersion.object_id !== object.id || targetVersion.namespace_id !== namespace.id) {
    throw new HttpError(404, "knowledge_version_not_found");
  }
  const r2Object = await env.KNOWLEDGE_OBJECTS.get(targetVersion.r2_key);
  if (!r2Object) {
    throw new HttpError(404, "knowledge_object_missing");
  }
  const bytes = new Uint8Array(await r2Object.arrayBuffer());
  const mimeType = targetVersion.mime_type || object.mime_type || contentTypeFromName(object.file_name);
  const version = await persistObjectVersion(
    env,
    namespace,
    object,
    principal,
    bytes,
    mimeType,
    contentKindFromMime(mimeType, object.file_name),
    targetVersion.sha256 || await sha256Hex(bytes),
    {
      ...mutation,
      editOperation: `restore:${targetVersion.id}`,
      operation: "restore_version"
    }
  );
  await processKnowledgeDiffOutboxAfterMutation(env, version.id);
  await dispatchKnowledgeIndexOutboxAfterMutation(env);
  return {
    object: await requireObject(env, object.id),
    version
  };
}

export async function restoreDeletedObject(
  env: Env,
  principal: Principal,
  objectId: string,
  mutation: KnowledgeMutationContext
) {
  if (!knowledgeV2Flags(env).mutationSpine) {
    throw new HttpError(503, "knowledge_restore_requires_mutation_spine");
  }
  const object = await requireDeletedObject(env, objectId);
  const namespace = await requireNamespaceForPrincipal(env, object.namespace_id, principal);
  const original = deletedObjectLocation(object);
  const root = await authorizeDeletedObjectRestore(env, namespace, object, original.path, principal);
  if (
    object.object_kind === "file"
    && (!mutation.expectedVersionId || mutation.expectedVersionId !== object.current_version_id)
  ) {
    throw new HttpError(
      mutation.expectedVersionId ? 409 : 428,
      mutation.expectedVersionId ? "knowledge_version_conflict" : "knowledge_expected_version_required"
    );
  }

  const deletedRows = object.object_kind === "folder"
    ? await env.KNOWLEDGE_DB
        .prepare(
          `SELECT * FROM knowledge_objects
           WHERE namespace_id = ? AND deleted_at IS NOT NULL
             AND (
               json_extract(metadata_json, '$.deletedOriginalPath') = ?
               OR substr(
                 json_extract(metadata_json, '$.deletedOriginalPath'),
                 1,
                 ?
               ) = ?
             )
           ORDER BY length(json_extract(metadata_json, '$.deletedOriginalPath')) ASC`
        )
        .bind(object.namespace_id, original.path, sqliteTextLength(`${original.path}/`), `${original.path}/`)
        .all<ObjectRow>()
    : { results: [object] };
  const restoreRows = deletedRows.results ?? [];
  if (restoreRows.length === 0) {
    throw new HttpError(404, "knowledge_object_not_found");
  }

  const locations = restoreRows.map((row) => ({
    row,
    location: deletedObjectLocation(row)
  }));
  for (const candidate of locations) {
    const conflict = await objectByPath(env, object.namespace_id, candidate.location.path);
    if (conflict) {
      throw new HttpError(409, "knowledge_restore_path_conflict");
    }
  }

  const idempotencyScope = `${principal.orgId}:${principal.sub}:${root.id}:restore`;
  const requestHash = await sha256Text(JSON.stringify({
    expectedVersionId: mutation.expectedVersionId,
    objectId: object.id,
    operation: "restore",
    path: original.path
  }));
  const replay = await existingMutationCommand(env, idempotencyScope, mutation.idempotencyKey);
  if (replay) {
    await assertCommittedMutationReplay(replay, requestHash);
    return {
      object: await requireObject(env, object.id),
      restoredCount: Number(safeJsonRecord(replay.result_json).restoredCount ?? 1)
    };
  }

  const commandId = `kmut_${crypto.randomUUID()}`;
  const changeSetId = `kchg_${crypto.randomUUID()}`;
  const changeItemId = `kchi_${crypto.randomUUID()}`;
  const restoredBytes = restoreRows.reduce((sum, row) => sum + row.size_bytes, 0);
  const expectedVersionId = object.current_version_id || "";
  const result = {
    changeSetId,
    objectId: object.id,
    path: original.path,
    restoredCount: restoreRows.length
  };
  const statements: D1PreparedStatement[] = [
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_mutation_commands (
           id, org_id, namespace_id, root_object_id, object_id, operation,
           expected_version_id, idempotency_scope, idempotency_key, request_hash
         )
         SELECT ?, ?, ?, ?, ?, 'restore', ?, ?, ?, ?
         FROM knowledge_objects
         WHERE id = ? AND namespace_id = ? AND deleted_at IS NOT NULL
           AND current_version_id = ?
           AND EXISTS (
             SELECT 1 FROM knowledge_namespaces
             WHERE id = ? AND (quota_bytes <= 0 OR used_bytes + ? <= quota_bytes)
           )
         ON CONFLICT(idempotency_scope, idempotency_key) DO NOTHING`
      )
      .bind(
        commandId,
        principal.orgId,
        object.namespace_id,
        root.id,
        object.id,
        expectedVersionId,
        idempotencyScope,
        mutation.idempotencyKey,
        requestHash,
        object.id,
        object.namespace_id,
        expectedVersionId,
        namespace.id,
        restoredBytes
      )
  ];
  for (const candidate of locations) {
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_objects
           SET parent_path = ?, path = ?,
               metadata_json = json_remove(
                 CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
                 '$.deletedOriginalPath',
                 '$.deletedOriginalParentPath'
               ),
               deleted_at = NULL, updated_by_user_id = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND namespace_id = ? AND deleted_at IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
             )`
        )
        .bind(
          candidate.location.parentPath,
          candidate.location.path,
          principal.sub,
          candidate.row.id,
          object.namespace_id,
          commandId
        )
    );
  }
  statements.push(
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_namespaces
         SET used_bytes = used_bytes + ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND (quota_bytes <= 0 OR used_bytes + ? <= quota_bytes)
           AND EXISTS (
             SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
           )`
      )
      .bind(restoredBytes, namespace.id, restoredBytes, commandId),
    ...changeAuditStatements(env, {
      action: "restore",
      changeItemId,
      changeSetId,
      commandId,
      expectedVersionId,
      mutation,
      object,
      operation: "restore",
      orgId: principal.orgId,
      pathAfter: original.path,
      pathBefore: "",
      principal,
      rootObjectId: root.id,
      versionAfterId: object.current_version_id,
      versionBeforeId: object.current_version_id
    }),
    commitMetadataMutationStatement(env, commandId, changeItemId, result)
  );
  await env.KNOWLEDGE_DB.batch(statements);
  const committed = await existingMutationCommand(env, idempotencyScope, mutation.idempotencyKey);
  await assertCommittedMutationReplay(committed, requestHash);

  if (!root.deleted_at) {
    await queueKnowledgeServicesForChangedPath(env, namespace.id, original.path);
  } else if (root.id === object.id) {
    await ensureRestoredRootOwner(env, namespace, object.id, principal);
  }
  return {
    object: await requireObject(env, object.id),
    restoredCount: restoreRows.length
  };
}

function deletedObjectLocation(object: ObjectRow) {
  const metadata = safeJsonRecord(object.metadata_json);
  const path = normalizePath(readString(metadata.deletedOriginalPath));
  const parentPath = normalizePath(
    readString(metadata.deletedOriginalParentPath) || parentPathFromPath(path)
  );
  if (!path || path.startsWith(".workspace-deleted/") || !path.split("/").at(-1)) {
    throw new HttpError(409, "knowledge_restore_metadata_missing");
  }
  return { parentPath, path };
}

async function authorizeDeletedObjectRestore(
  env: Env,
  namespace: NamespaceRow,
  object: ObjectRow,
  originalPath: string,
  principal: Principal
) {
  const rootPath = originalPath.split("/")[0];
  const activeRoot = await objectByPath(env, namespace.id, rootPath);
  if (activeRoot?.object_kind === "folder" && !activeRoot.parent_path) {
    const role = await accessRoleForObject(env, namespace, activeRoot, principal);
    if (roleHasKnowledgeCapability(role, "editContent")) {
      return activeRoot;
    }
    throw new HttpError(403, "knowledge_restore_denied");
  }
  const deletedRoot = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT * FROM knowledge_objects
       WHERE namespace_id = ? AND object_kind = 'folder' AND deleted_at IS NOT NULL
         AND json_extract(metadata_json, '$.deletedOriginalPath') = ?
         AND json_extract(metadata_json, '$.deletedOriginalParentPath') = ''
       ORDER BY deleted_at DESC
       LIMIT 1`
    )
    .bind(namespace.id, rootPath)
    .first<ObjectRow>();
  if (!deletedRoot || (deletedRoot.id !== object.id && !originalPath.startsWith(`${rootPath}/`))) {
    throw new HttpError(403, "knowledge_restore_denied");
  }
  if (object.id !== deletedRoot.id) {
    throw new HttpError(409, "knowledge_restore_root_first");
  }
  const latestOwner = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT * FROM knowledge_permissions
       WHERE object_id = ? AND subject_type = 'user' AND role = 'owner'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`
    )
    .bind(deletedRoot.id)
    .first<PermissionRow>();
  if (!latestOwner || latestOwner.subject_id !== principal.sub) {
    throw new HttpError(403, "knowledge_restore_owner_required");
  }
  return deletedRoot;
}

async function ensureRestoredRootOwner(
  env: Env,
  namespace: NamespaceRow,
  rootObjectId: string,
  principal: Principal
) {
  const existingOwner = await activeRootOwnerGrant(env, rootObjectId);
  if (existingOwner) return;
  const permissionId = `kperm_${crypto.randomUUID()}`;
  await env.KNOWLEDGE_DB.batch([
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_permissions (
           id, namespace_id, object_id, subject_type, subject_id, role,
           can_share, can_publish_skill, granted_by_user_id, expires_at
         ) VALUES (?, ?, ?, 'user', ?, 'owner', 1, 0, ?, NULL)`
      )
      .bind(permissionId, namespace.id, rootObjectId, principal.sub, principal.sub),
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_permission_provenance (
           permission_id, grant_source, source_id
         ) VALUES (?, 'direct', ?)`
      )
      .bind(permissionId, rootObjectId)
  ]);
}
