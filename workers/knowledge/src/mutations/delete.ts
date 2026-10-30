import { sqliteTextLength } from "../sql.ts";
import { dispatchKnowledgeIndexOutboxAfterMutation } from "../indexing/outbox.ts";
import { knowledgeV2Flags } from "../knowledge-v2-flags.ts";
import { sha256Text } from "../objects/content.ts";
import { requireRootObjectForMutation } from "../objects/repository.ts";
import { markKnowledgeServicesStaleForPath } from "../services/invalidation.ts";
import type { Env, KnowledgeMutationContext, ObjectRow, Principal } from "../types.ts";
import {
  assertCommittedMutationReplay,
  assertExpectedVersionForMutation,
  changeAuditStatements,
  commitMetadataMutationStatement,
  existingMutationCommand,
  mutationCommandGuardStatement,
  mutationDeleteResult
} from "./commands.ts";
import { indexOutboxStatements } from "./indexOutbox.ts";

export async function deleteObject(
  env: Env,
  principal: Principal,
  object: ObjectRow,
  mutation?: KnowledgeMutationContext
) {
  if (knowledgeV2Flags(env).mutationSpine && mutation) {
    return deleteObjectV2(env, principal, object, mutation);
  }
  const folderPrefix = `${object.path}/`;
  const folderPrefixLength = sqliteTextLength(folderPrefix);
  const includeDescendants = object.object_kind === "folder" ? 1 : 0;
  const [summaryResult] = await env.KNOWLEDGE_DB.batch([
    env.KNOWLEDGE_DB
      .prepare(
        `
        SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
        FROM knowledge_objects
        WHERE namespace_id = ?
          AND deleted_at IS NULL
          AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
        `
      )
      .bind(object.namespace_id, object.id, includeDescendants, folderPrefixLength, folderPrefix),
    env.KNOWLEDGE_DB
      .prepare(
        `
        UPDATE knowledge_shares
        SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        WHERE namespace_id = ?
          AND revoked_at IS NULL
          AND object_id IN (
            SELECT id
            FROM knowledge_objects
            WHERE namespace_id = ?
              AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
          )
        `
      )
      .bind(object.namespace_id, object.namespace_id, object.id, includeDescendants, folderPrefixLength, folderPrefix),
    env.KNOWLEDGE_DB
      .prepare(
        `
        UPDATE knowledge_permissions
        SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        WHERE namespace_id = ?
          AND revoked_at IS NULL
          AND object_id IN (
            SELECT id
            FROM knowledge_objects
            WHERE namespace_id = ?
              AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
          )
        `
      )
      .bind(object.namespace_id, object.namespace_id, object.id, includeDescendants, folderPrefixLength, folderPrefix),
    env.KNOWLEDGE_DB
      .prepare(
        `
        UPDATE knowledge_open_tokens
        SET consumed_at = COALESCE(consumed_at, CURRENT_TIMESTAMP)
        WHERE namespace_id = ?
          AND consumed_at IS NULL
          AND object_id IN (
            SELECT id
            FROM knowledge_objects
            WHERE namespace_id = ?
              AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
          )
        `
      )
      .bind(object.namespace_id, object.namespace_id, object.id, includeDescendants, folderPrefixLength, folderPrefix),
    env.KNOWLEDGE_DB
      .prepare(
        `
        UPDATE knowledge_root_owner_transfers
        SET status = 'cancelled',
            decided_by_user_id = ?,
            decided_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE namespace_id = ?
          AND status = 'pending'
          AND root_object_id IN (
            SELECT id
            FROM knowledge_objects
            WHERE namespace_id = ?
              AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
          )
        `
      )
      .bind(
        principal.sub,
        object.namespace_id,
        object.namespace_id,
        object.id,
        includeDescendants,
        folderPrefixLength,
        folderPrefix
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `
        UPDATE knowledge_services
        SET status = 'archived',
            updated_at = CURRENT_TIMESTAMP
        WHERE namespace_id = ?
          AND status != 'archived'
          AND (
            folder_object_id IN (
              SELECT id
              FROM knowledge_objects
              WHERE namespace_id = ?
                AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
            )
            OR handbook_object_id IN (
              SELECT id
              FROM knowledge_objects
              WHERE namespace_id = ?
                AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
            )
          )
        `
      )
      .bind(
        object.namespace_id,
        object.namespace_id,
        object.id,
        includeDescendants,
        folderPrefixLength,
        folderPrefix,
        object.namespace_id,
        object.id,
        includeDescendants,
        folderPrefixLength,
        folderPrefix
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `
        UPDATE knowledge_namespaces
        SET used_bytes = MAX(
              0,
              used_bytes - COALESCE((
                SELECT SUM(size_bytes)
                FROM knowledge_objects
                WHERE namespace_id = ?
                  AND deleted_at IS NULL
                  AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
              ), 0)
            ),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `
      )
      .bind(
        object.namespace_id,
        object.id,
        includeDescendants,
        folderPrefixLength,
        folderPrefix,
        object.namespace_id
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `
        UPDATE knowledge_objects
        SET metadata_json = json_set(
              CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
              '$.deletedOriginalPath', path,
              '$.deletedOriginalParentPath', parent_path
            ),
            parent_path = '/.workspace-deleted',
            path = '/.workspace-deleted/' || id,
            deleted_at = CURRENT_TIMESTAMP,
            updated_by_user_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE namespace_id = ?
          AND deleted_at IS NULL
          AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
        `
      )
      .bind(principal.sub, object.namespace_id, object.id, includeDescendants, folderPrefixLength, folderPrefix)
  ]);
  const deletedSummary = summaryResult.results?.[0] as { count?: number; bytes?: number } | undefined;

  await markKnowledgeServicesStaleForPath(env, object.namespace_id, object.path);

  return {
    deletedBytes: Number(deletedSummary?.bytes ?? 0),
    deletedCount: Number(deletedSummary?.count ?? 0),
    deletedObjectId: object.id
  };
}

async function deleteObjectV2(
  env: Env,
  principal: Principal,
  object: ObjectRow,
  mutation: KnowledgeMutationContext
) {
  assertExpectedVersionForMutation(object, mutation);
  const root = await requireRootObjectForMutation(env, object);
  const idempotencyScope = `${principal.orgId}:${principal.sub}:${root.id}:delete`;
  const requestHash = await sha256Text(JSON.stringify({
    expectedVersionId: mutation.expectedVersionId,
    objectId: object.id,
    operation: "delete",
    path: object.path,
    sha256: object.sha256
  }));
  const replay = await existingMutationCommand(env, idempotencyScope, mutation.idempotencyKey);
  if (replay) {
    await assertCommittedMutationReplay(replay, requestHash);
    return mutationDeleteResult(replay, object.id);
  }

  const commandId = `kmut_${crypto.randomUUID()}`;
  const changeSetId = `kchg_${crypto.randomUUID()}`;
  const changeItemId = `kchi_${crypto.randomUUID()}`;
  const indexOutboxPrefix = `kidx_${crypto.randomUUID()}`;
  const folderPrefix = `${object.path}/`;
  const includeDescendants = object.object_kind === "folder" ? 1 : 0;
  const expectedVersionId = object.current_version_id || "";
  const statements: D1PreparedStatement[] = [
    mutationCommandGuardStatement(env, {
      commandId,
      expectedVersionId,
      idempotencyKey: mutation.idempotencyKey,
      idempotencyScope,
      namespaceId: object.namespace_id,
      objectId: object.id,
      operation: "delete",
      orgId: principal.orgId,
      requestHash,
      rootObjectId: root.id
    }),
    env.KNOWLEDGE_DB
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
         FROM knowledge_objects
         WHERE namespace_id = ? AND deleted_at IS NULL
           AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
           AND EXISTS (
             SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
           )`
      )
      .bind(
        object.namespace_id,
        object.id,
        includeDescendants,
        sqliteTextLength(folderPrefix),
        folderPrefix,
        commandId
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_shares
         SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
         WHERE namespace_id = ? AND revoked_at IS NULL
           AND object_id IN (
             SELECT id FROM knowledge_objects
             WHERE namespace_id = ?
               AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
           )
           AND EXISTS (
             SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
           )`
      )
      .bind(
        object.namespace_id,
        object.namespace_id,
        object.id,
        includeDescendants,
        sqliteTextLength(folderPrefix),
        folderPrefix,
        commandId
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_permissions
         SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
         WHERE namespace_id = ? AND revoked_at IS NULL
           AND object_id IN (
             SELECT id FROM knowledge_objects
             WHERE namespace_id = ?
               AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
           )
           AND EXISTS (
             SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
           )`
      )
      .bind(
        object.namespace_id,
        object.namespace_id,
        object.id,
        includeDescendants,
        sqliteTextLength(folderPrefix),
        folderPrefix,
        commandId
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_open_tokens
         SET consumed_at = COALESCE(consumed_at, CURRENT_TIMESTAMP)
         WHERE namespace_id = ? AND consumed_at IS NULL
           AND object_id IN (
             SELECT id FROM knowledge_objects
             WHERE namespace_id = ?
               AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
           )
           AND EXISTS (
             SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
           )`
      )
      .bind(
        object.namespace_id,
        object.namespace_id,
        object.id,
        includeDescendants,
        sqliteTextLength(folderPrefix),
        folderPrefix,
        commandId
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_root_owner_transfers
         SET status = 'cancelled',
             decided_by_user_id = ?,
             decided_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE namespace_id = ? AND status = 'pending'
           AND root_object_id IN (
             SELECT id FROM knowledge_objects
             WHERE namespace_id = ?
               AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
           )
           AND EXISTS (
             SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
           )`
      )
      .bind(
        principal.sub,
        object.namespace_id,
        object.namespace_id,
        object.id,
        includeDescendants,
        sqliteTextLength(folderPrefix),
        folderPrefix,
        commandId
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_services
         SET status = 'archived', agent_enabled = 0, index_status = 'disabled',
             updated_at = CURRENT_TIMESTAMP
         WHERE namespace_id = ? AND status != 'archived'
           AND (
             folder_object_id IN (
               SELECT id FROM knowledge_objects
               WHERE namespace_id = ?
                 AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
             )
             OR handbook_object_id IN (
               SELECT id FROM knowledge_objects
               WHERE namespace_id = ?
                 AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
             )
           )
           AND EXISTS (
             SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
           )`
      )
      .bind(
        object.namespace_id,
        object.namespace_id,
        object.id,
        includeDescendants,
        sqliteTextLength(folderPrefix),
        folderPrefix,
        object.namespace_id,
        object.id,
        includeDescendants,
        sqliteTextLength(folderPrefix),
        folderPrefix,
        commandId
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_namespaces
         SET used_bytes = MAX(
               0,
               used_bytes - COALESCE((
                 SELECT SUM(size_bytes) FROM knowledge_objects
                 WHERE namespace_id = ? AND deleted_at IS NULL
                   AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
               ), 0)
             ),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
           )`
      )
      .bind(
        object.namespace_id,
        object.id,
        includeDescendants,
        sqliteTextLength(folderPrefix),
        folderPrefix,
        object.namespace_id,
        commandId
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_objects
         SET metadata_json = json_set(
               CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
               '$.deletedOriginalPath', path,
               '$.deletedOriginalParentPath', parent_path
             ),
             parent_path = '/.workspace-deleted',
             path = '/.workspace-deleted/' || id,
             deleted_at = CURRENT_TIMESTAMP,
             updated_by_user_id = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE namespace_id = ? AND deleted_at IS NULL
           AND (id = ? OR (? = 1 AND substr(path, 1, ?) = ?))
           AND EXISTS (
             SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
           )`
      )
      .bind(
        principal.sub,
        object.namespace_id,
        object.id,
        includeDescendants,
        sqliteTextLength(folderPrefix),
        folderPrefix,
        commandId
      )
  ];
  statements.push(
    ...changeAuditStatements(env, {
      action: object.object_kind === "folder" ? "folder_delete" : "delete",
      changeItemId,
      changeSetId,
      commandId,
      expectedVersionId,
      mutation,
      object,
      operation: "delete",
      orgId: principal.orgId,
      pathAfter: "",
      pathBefore: object.path,
      principal,
      rootObjectId: root.id,
      versionAfterId: "",
      versionBeforeId: object.current_version_id
    }),
    ...indexOutboxStatements(
      env,
      object,
      changeSetId,
      "",
      "delete",
      indexOutboxPrefix,
      commandId
    )
  );
  const resultJson = {
    changeSetId,
    deletedBytes: object.size_bytes,
    deletedCount: 1,
    deletedObjectId: object.id
  };
  statements.push(commitMetadataMutationStatement(env, commandId, changeItemId, resultJson));
  const batchResults = await env.KNOWLEDGE_DB.batch(statements);
  const summary = batchResults[1]?.results?.[0] as { bytes?: number; count?: number } | undefined;
  resultJson.deletedBytes = Number(summary?.bytes ?? object.size_bytes);
  resultJson.deletedCount = Number(summary?.count ?? 1);
  const committed = await existingMutationCommand(env, idempotencyScope, mutation.idempotencyKey);
  await assertCommittedMutationReplay(committed, requestHash);
  await dispatchKnowledgeIndexOutboxAfterMutation(env);
  return {
    deletedBytes: resultJson.deletedBytes,
    deletedCount: resultJson.deletedCount,
    deletedObjectId: object.id
  };
}
