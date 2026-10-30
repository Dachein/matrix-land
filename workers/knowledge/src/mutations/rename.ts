import { sqliteTextLength } from "../sql.ts";
import { HttpError } from "../http.ts";
import { dispatchKnowledgeIndexOutboxAfterMutation } from "../indexing/outbox.ts";
import { knowledgeV2Flags } from "../knowledge-v2-flags.ts";
import { sha256Text } from "../objects/content.ts";
import { objectByPath, requireObject, requireRootObjectForMutation } from "../objects/repository.ts";
import { joinPath, validateFileName, validateFolderName } from "../paths.ts";
import { markKnowledgeServicesStaleForPath } from "../services/invalidation.ts";
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

export async function renameObject(
  env: Env,
  principal: Principal,
  object: ObjectRow,
  rawName: string,
  mutation?: KnowledgeMutationContext
) {
  const fileName = object.object_kind === "folder" ? validateFolderName(rawName) : validateFileName(rawName);
  if (fileName === object.file_name) {
    return object;
  }

  const newPath = joinPath(object.parent_path, fileName);
  const existing = await objectByPath(env, object.namespace_id, newPath);
  if (existing && existing.id !== object.id) {
    throw new HttpError(409, "knowledge_name_conflict");
  }

  if (knowledgeV2Flags(env).mutationSpine && mutation) {
    return renameObjectV2(env, principal, object, fileName, newPath, mutation);
  }

  if (object.object_kind === "folder") {
    await renameFolderObject(env, principal, object, fileName, newPath);
  } else {
    await env.KNOWLEDGE_DB
      .prepare(
        `
        UPDATE knowledge_objects
        SET file_name = ?,
            path = ?,
            title = CASE WHEN title IS NULL OR title = '' OR title = ? THEN ? ELSE title END,
            updated_by_user_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `
      )
      .bind(fileName, newPath, object.file_name, fileName, principal.sub, object.id)
      .run();
  }

  await markKnowledgeServicesStaleForPath(env, object.namespace_id, object.path);
  await markKnowledgeServicesStaleForPath(env, object.namespace_id, newPath);

  return requireObject(env, object.id);
}

async function renameObjectV2(
  env: Env,
  principal: Principal,
  object: ObjectRow,
  fileName: string,
  newPath: string,
  mutation: KnowledgeMutationContext
) {
  assertExpectedVersionForMutation(object, mutation);
  const root = await requireRootObjectForMutation(env, object);
  const idempotencyScope = `${principal.orgId}:${principal.sub}:${root.id}:rename`;
  const requestHash = await sha256Text(JSON.stringify({
    expectedVersionId: mutation.expectedVersionId,
    fileName,
    objectId: object.id,
    operation: "rename",
    pathBefore: object.path,
    pathAfter: newPath
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
  const statements: D1PreparedStatement[] = [
    mutationCommandGuardStatement(
      env,
      {
        commandId,
        expectedVersionId,
        idempotencyKey: mutation.idempotencyKey,
        idempotencyScope,
        namespaceId: object.namespace_id,
        objectId: object.id,
        operation: "rename",
        orgId: principal.orgId,
        requestHash,
        rootObjectId: root.id
      }
    )
  ];
  if (object.object_kind === "folder") {
    const oldPrefix = `${oldPath}/`;
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
                 WHEN id = ? THEN parent_path
                 WHEN parent_path = ? THEN ?
                 WHEN substr(parent_path, 1, ?) = ? THEN ? || substr(parent_path, ?)
                 ELSE parent_path
               END,
               file_name = CASE WHEN id = ? THEN ? ELSE file_name END,
               title = CASE WHEN id = ? AND (title IS NULL OR title = '' OR title = ?) THEN ? ELSE title END,
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
          oldPath,
          newPath,
          sqliteTextLength(oldPrefix),
          oldPrefix,
          newPath,
          sqliteTextLength(oldPath) + 1,
          object.id,
          fileName,
          object.id,
          object.file_name,
          fileName,
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
           SET file_name = ?, path = ?,
               title = CASE WHEN title IS NULL OR title = '' OR title = ? THEN ? ELSE title END,
               updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND namespace_id = ? AND deleted_at IS NULL
             AND current_version_id = ?
             AND EXISTS (
               SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
             )`
        )
        .bind(
          fileName,
          newPath,
          object.file_name,
          fileName,
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
      action: object.object_kind === "folder" ? "folder_rename" : "rename",
      changeItemId,
      changeSetId,
      commandId,
      expectedVersionId,
      mutation,
      object,
      operation: "rename",
      orgId: principal.orgId,
      pathAfter: newPath,
      pathBefore: oldPath,
      principal,
      rootObjectId: root.id,
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
      path: newPath
    })
  );
  await env.KNOWLEDGE_DB.batch(statements);
  const committed = await existingMutationCommand(env, idempotencyScope, mutation.idempotencyKey);
  await assertCommittedMutationReplay(committed, requestHash);
  await dispatchKnowledgeIndexOutboxAfterMutation(env);
  return requireObject(env, object.id);
}

async function renameFolderObject(env: Env, principal: Principal, object: ObjectRow, fileName: string, newPath: string) {
  const oldPath = object.path;
  const oldPrefix = `${oldPath}/`;
  const prefixLength = sqliteTextLength(oldPrefix);
  const suffixStart = sqliteTextLength(oldPath) + 1;
  await env.KNOWLEDGE_DB
    .prepare(
      `
      UPDATE knowledge_objects
      SET path = CASE
            WHEN id = ? THEN ?
            WHEN substr(path, 1, ?) = ? THEN ? || substr(path, ?)
            ELSE path
          END,
          parent_path = CASE
            WHEN id = ? THEN parent_path
            WHEN parent_path = ? THEN ?
            WHEN substr(parent_path, 1, ?) = ? THEN ? || substr(parent_path, ?)
            ELSE parent_path
          END,
          file_name = CASE WHEN id = ? THEN ? ELSE file_name END,
          title = CASE WHEN id = ? AND (title IS NULL OR title = '' OR title = ?) THEN ? ELSE title END,
          updated_by_user_id = CASE WHEN id = ? THEN ? ELSE updated_by_user_id END,
          updated_at = CURRENT_TIMESTAMP
      WHERE namespace_id = ?
        AND deleted_at IS NULL
        AND (id = ? OR substr(path, 1, ?) = ?)
      `
    )
    .bind(
      object.id,
      newPath,
      prefixLength,
      oldPrefix,
      newPath,
      suffixStart,
      object.id,
      oldPath,
      newPath,
      prefixLength,
      oldPrefix,
      newPath,
      suffixStart,
      object.id,
      fileName,
      object.id,
      object.file_name,
      fileName,
      object.id,
      principal.sub,
      object.namespace_id,
      object.id,
      prefixLength,
      oldPrefix
    )
    .run();
}
