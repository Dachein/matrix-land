import { dispatchKnowledgeIndexOutboxAfterMutation } from "../indexing/outbox.ts";
import { knowledgeV2Flags } from "../knowledge-v2-flags.ts";
import { sha256Text } from "../objects/content.ts";
import { objectByPath, requireObject, requireRootObjectForMutation } from "../objects/repository.ts";
import { joinPath, normalizePath, validateFolderName } from "../paths.ts";
import { markKnowledgeServicesStaleForPath } from "../services/invalidation.ts";
import type { Env, KnowledgeMutationContext, NamespaceRow, ObjectRow, Principal } from "../types.ts";
import { readString, safeJsonRecord } from "../values.ts";
import {
  assertCommittedMutationReplay,
  changeAuditStatements,
  commitMetadataMutationStatement,
  existingMutationCommand,
  mutationCommandGuardStatement
} from "./commands.ts";
import { indexOutboxStatements } from "./indexOutbox.ts";

export async function createFolder(
  env: Env,
  namespace: NamespaceRow,
  principal: Principal,
  rawParentPath: string,
  rawName: string,
  mutation?: KnowledgeMutationContext
) {
  const parentPath = normalizePath(rawParentPath);
  const fileName = validateFolderName(rawName);
  const path = joinPath(parentPath, fileName);
  const existing = await objectByPath(env, namespace.id, path);
  if (existing) {
    return existing;
  }
  if (knowledgeV2Flags(env).mutationSpine && mutation) {
    return createFolderV2(env, namespace, principal, parentPath, path, fileName, mutation);
  }
  const id = `kobj_${crypto.randomUUID()}`;
  const createFolderStatement = env.KNOWLEDGE_DB
    .prepare(
      `
      INSERT INTO knowledge_objects (
        id, namespace_id, parent_path, path, file_name, object_kind, mime_type, content_kind,
        created_by_user_id, updated_by_user_id
      )
      VALUES (?, ?, ?, ?, ?, 'folder', 'application/x-directory', 'folder', ?, ?)
      `
    )
    .bind(id, namespace.id, parentPath, path, fileName, principal.sub, principal.sub);
  if (!parentPath) {
    const permissionId = `kperm_${crypto.randomUUID()}`;
    await env.KNOWLEDGE_DB.batch([
      createFolderStatement,
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_permissions (
             id, namespace_id, object_id, subject_type, subject_id, role,
             can_share, can_publish_skill, granted_by_user_id, expires_at
           ) VALUES (?, ?, ?, 'user', ?, 'owner', 1, 0, ?, NULL)`
        )
        .bind(permissionId, namespace.id, id, principal.sub, principal.sub),
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_permission_provenance (
             permission_id, grant_source, source_id
           ) VALUES (?, 'direct', ?)`
        )
        .bind(permissionId, id)
    ]);
  } else {
    await createFolderStatement.run();
  }
  await markKnowledgeServicesStaleForPath(env, namespace.id, path);
  return requireObject(env, id);
}

async function createFolderV2(
  env: Env,
  namespace: NamespaceRow,
  principal: Principal,
  parentPath: string,
  path: string,
  fileName: string,
  mutation: KnowledgeMutationContext
) {
  const id = `kobj_${crypto.randomUUID()}`;
  const root = parentPath
    ? await requireRootObjectForMutation(env, {
        id,
        namespace_id: namespace.id,
        parent_path: parentPath,
        path,
        file_name: fileName,
        object_kind: "folder",
        mime_type: "application/x-directory",
        content_kind: "folder",
        current_version_id: "",
        title: fileName,
        description: "",
        tags_json: "[]",
        metadata_json: "{}",
        size_bytes: 0,
        sha256: "",
        created_by_user_id: principal.sub,
        updated_by_user_id: principal.sub,
        created_at: "",
        updated_at: "",
        deleted_at: null
      })
    : undefined;
  const rootObjectId = root?.id ?? id;
  const idempotencyScope = `${principal.orgId}:${principal.sub}:${rootObjectId}:folder_create`;
  const requestHash = await sha256Text(JSON.stringify({
    operation: "folder_create",
    parentPath,
    path
  }));
  const replay = await existingMutationCommand(env, idempotencyScope, mutation.idempotencyKey);
  if (replay) {
    await assertCommittedMutationReplay(replay, requestHash);
    const result = safeJsonRecord(replay.result_json);
    return requireObject(env, readString(result.objectId) || id);
  }
  const commandId = `kmut_${crypto.randomUUID()}`;
  const changeSetId = `kchg_${crypto.randomUUID()}`;
  const changeItemId = `kchi_${crypto.randomUUID()}`;
  const indexOutboxPrefix = `kidx_${crypto.randomUUID()}`;
  const plannedObject: ObjectRow = {
    id,
    namespace_id: namespace.id,
    parent_path: parentPath,
    path,
    file_name: fileName,
    object_kind: "folder",
    mime_type: "application/x-directory",
    content_kind: "folder",
    current_version_id: "",
    title: fileName,
    description: "",
    tags_json: "[]",
    metadata_json: "{}",
    size_bytes: 0,
    sha256: "",
    created_by_user_id: principal.sub,
    updated_by_user_id: principal.sub,
    created_at: "",
    updated_at: "",
    deleted_at: null
  };
  const statements: D1PreparedStatement[] = [
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_objects (
           id, namespace_id, parent_path, path, file_name, object_kind, mime_type, content_kind,
           title, created_by_user_id, updated_by_user_id
         ) VALUES (?, ?, ?, ?, ?, 'folder', 'application/x-directory', 'folder', ?, ?, ?)`
      )
      .bind(id, namespace.id, parentPath, path, fileName, fileName, principal.sub, principal.sub),
    mutationCommandGuardStatement(env, {
      commandId,
      expectedVersionId: "",
      idempotencyKey: mutation.idempotencyKey,
      idempotencyScope,
      namespaceId: namespace.id,
      objectId: id,
      operation: "folder_create",
      orgId: principal.orgId,
      requestHash,
      rootObjectId
    })
  ];
  if (!parentPath) {
    const permissionId = `kperm_${crypto.randomUUID()}`;
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_permissions (
             id, namespace_id, object_id, subject_type, subject_id, role,
             can_share, can_publish_skill, granted_by_user_id, expires_at
           )
           SELECT ?, ?, ?, 'user', ?, 'owner', 1, 0, ?, NULL
           FROM knowledge_mutation_commands
           WHERE id = ? AND status = 'prepared'`
        )
        .bind(permissionId, namespace.id, id, principal.sub, principal.sub, commandId),
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_permission_provenance (permission_id, grant_source, source_id)
           SELECT ?, 'direct', ?
           FROM knowledge_mutation_commands
           WHERE id = ? AND status = 'prepared'`
        )
        .bind(permissionId, id, commandId)
    );
  }
  statements.push(
    ...changeAuditStatements(env, {
      action: "folder_create",
      changeItemId,
      changeSetId,
      commandId,
      expectedVersionId: "",
      mutation,
      object: plannedObject,
      operation: "folder_create",
      orgId: principal.orgId,
      pathAfter: path,
      pathBefore: "",
      principal,
      rootObjectId,
      versionAfterId: "",
      versionBeforeId: ""
    }),
    ...indexOutboxStatements(
      env,
      plannedObject,
      changeSetId,
      "",
      "upsert",
      indexOutboxPrefix,
      commandId
    ),
    commitMetadataMutationStatement(env, commandId, changeItemId, {
      changeSetId,
      objectId: id,
      path
    })
  );
  await env.KNOWLEDGE_DB.batch(statements);
  const committed = await existingMutationCommand(env, idempotencyScope, mutation.idempotencyKey);
  await assertCommittedMutationReplay(committed, requestHash);
  await dispatchKnowledgeIndexOutboxAfterMutation(env);
  return requireObject(env, id);
}
