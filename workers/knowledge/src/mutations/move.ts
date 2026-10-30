import { sqliteTextLength } from "../sql.ts";
import { HttpError } from "../http.ts";
import { dispatchKnowledgeIndexOutboxAfterMutation } from "../indexing/outbox.ts";
import { sha256Text } from "../objects/content.ts";
import { objectByPath, requireObject, requireRootObjectForMutation } from "../objects/repository.ts";
import { joinPath } from "../paths.ts";
import type { Env, KnowledgeMutationContext, ObjectRow, Principal } from "../types.ts";
import {
  assertCommittedMutationReplay,
  assertExpectedVersionForMutation,
  changeAuditStatements,
  commitMetadataMutationStatement,
  existingMutationCommand,
  mutationCommandGuardStatement
} from "./commands.ts";
import { indexOutboxStatements } from "./indexOutbox.ts";

export async function moveObject(
  env: Env,
  principal: Principal,
  object: ObjectRow,
  parent: ObjectRow,
  mutation: KnowledgeMutationContext
) {
  if (parent.object_kind !== "folder") {
    throw new HttpError(400, "knowledge_move_parent_not_folder");
  }
  if (object.namespace_id !== parent.namespace_id) {
    throw new HttpError(400, "knowledge_move_cross_namespace_denied");
  }
  if (!object.parent_path) {
    throw new HttpError(400, "knowledge_move_root_denied");
  }
  if (
    object.id === parent.id
    || (object.object_kind === "folder" && parent.path.startsWith(`${object.path}/`))
  ) {
    throw new HttpError(400, "knowledge_move_cycle");
  }
  const sourceRoot = await requireRootObjectForMutation(env, object);
  const targetRoot = await requireRootObjectForMutation(env, parent);
  if (sourceRoot.id !== targetRoot.id) {
    throw new HttpError(400, "knowledge_move_cross_root_denied");
  }
  const newPath = joinPath(parent.path, object.file_name);
  if (newPath === object.path) {
    return object;
  }
  const conflict = await objectByPath(env, object.namespace_id, newPath);
  if (conflict && conflict.id !== object.id) {
    throw new HttpError(409, "knowledge_name_conflict");
  }
  assertExpectedVersionForMutation(object, mutation);

  const idempotencyScope = `${principal.orgId}:${principal.sub}:${sourceRoot.id}:move`;
  const requestHash = await sha256Text(JSON.stringify({
    expectedVersionId: mutation.expectedVersionId,
    objectId: object.id,
    operation: "move",
    parentObjectId: parent.id,
    pathAfter: newPath,
    pathBefore: object.path
  }));
  const replay = await existingMutationCommand(env, idempotencyScope, mutation.idempotencyKey);
  if (replay) {
    await assertCommittedMutationReplay(replay, requestHash);
    return requireObject(env, object.id);
  }

  const commandId = `kmut_${crypto.randomUUID()}`;
  const changeSetId = `kchg_${crypto.randomUUID()}`;
  const changeItemId = `kchi_${crypto.randomUUID()}`;
  const indexOutboxPrefix = `kidx_${crypto.randomUUID()}`;
  const expectedVersionId = object.current_version_id || "";
  const oldPath = object.path;
  const oldPrefix = `${oldPath}/`;
  const statements: D1PreparedStatement[] = [
    mutationCommandGuardStatement(env, {
      commandId,
      expectedVersionId,
      idempotencyKey: mutation.idempotencyKey,
      idempotencyScope,
      namespaceId: object.namespace_id,
      objectId: object.id,
      operation: "move",
      orgId: principal.orgId,
      requestHash,
      rootObjectId: sourceRoot.id
    })
  ];

  if (object.object_kind === "folder") {
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_objects
           SET path = CASE
                 WHEN id = ? THEN ?
                 WHEN substr(path, 1, ?) = ? THEN ? || substr(path, ?)
                 ELSE path
               END,
               parent_path = CASE
                 WHEN id = ? THEN ?
                 WHEN parent_path = ? THEN ?
                 WHEN substr(parent_path, 1, ?) = ? THEN ? || substr(parent_path, ?)
                 ELSE parent_path
               END,
               updated_by_user_id = CASE WHEN id = ? THEN ? ELSE updated_by_user_id END,
               updated_at = CURRENT_TIMESTAMP
           WHERE namespace_id = ? AND deleted_at IS NULL
             AND (id = ? OR substr(path, 1, ?) = ?)
             AND EXISTS (
               SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
             )`
        )
        .bind(
          object.id,
          newPath,
          sqliteTextLength(oldPrefix),
          oldPrefix,
          newPath,
          sqliteTextLength(oldPath) + 1,
          object.id,
          parent.path,
          oldPath,
          newPath,
          sqliteTextLength(oldPrefix),
          oldPrefix,
          newPath,
          sqliteTextLength(oldPath) + 1,
          object.id,
          principal.sub,
          object.namespace_id,
          object.id,
          sqliteTextLength(oldPrefix),
          oldPrefix,
          commandId
        )
    );
  } else {
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_objects
           SET parent_path = ?, path = ?, updated_by_user_id = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND namespace_id = ? AND deleted_at IS NULL
             AND current_version_id = ?
             AND EXISTS (
               SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
             )`
        )
        .bind(
          parent.path,
          newPath,
          principal.sub,
          object.id,
          object.namespace_id,
          expectedVersionId,
          commandId
        )
    );
  }

  statements.push(
    ...changeAuditStatements(env, {
      action: object.object_kind === "folder" ? "folder_move" : "move",
      changeItemId,
      changeSetId,
      commandId,
      expectedVersionId,
      mutation,
      object,
      operation: "move",
      orgId: principal.orgId,
      pathAfter: newPath,
      pathBefore: oldPath,
      principal,
      rootObjectId: sourceRoot.id,
      versionAfterId: object.current_version_id,
      versionBeforeId: object.current_version_id
    }),
    ...indexOutboxStatements(
      env,
      object,
      changeSetId,
      object.current_version_id,
      "rename",
      indexOutboxPrefix,
      commandId
    ),
    commitMetadataMutationStatement(env, commandId, changeItemId, {
      changeSetId,
      objectId: object.id,
      parentObjectId: parent.id,
      path: newPath
    })
  );
  await env.KNOWLEDGE_DB.batch(statements);
  const committed = await existingMutationCommand(env, idempotencyScope, mutation.idempotencyKey);
  await assertCommittedMutationReplay(committed, requestHash);
  await dispatchKnowledgeIndexOutboxAfterMutation(env);
  return requireObject(env, object.id);
}
