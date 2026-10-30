import { HttpError } from "../http.ts";
import type { Env, KnowledgeMutationCommandRow, KnowledgeMutationContext, ObjectRow, Principal } from "../types.ts";
import { requiredKnowledgeActorEmail } from "../identity.ts";
import { requireVersion } from "../objects/repository.ts";
import { safeErrorName } from "../errors.ts";
import { readString, safeJsonRecord } from "../values.ts";

// Mutation replay and audit statements share the same guarded D1 transaction.

export async function existingMutationCommand(
  env: Env,
  idempotencyScope: string,
  idempotencyKey: string
) {
  return env.KNOWLEDGE_DB
    .prepare(
      `SELECT id, idempotency_scope, idempotency_key, request_hash, status,
              version_after_id, result_json, error_code
       FROM knowledge_mutation_commands
       WHERE idempotency_scope = ? AND idempotency_key = ?
       LIMIT 1`
    )
    .bind(idempotencyScope, idempotencyKey)
    .first<KnowledgeMutationCommandRow>();
}

export async function existingMutationCommandSafely(
  env: Env,
  idempotencyScope: string,
  idempotencyKey: string,
  cause: unknown
) {
  try {
    return await existingMutationCommand(env, idempotencyScope, idempotencyKey);
  } catch (lookupError) {
    console.error("knowledge_mutation_commit_state_unknown", {
      causeName: safeErrorName(cause),
      lookupErrorName: safeErrorName(lookupError)
    });
    throw cause;
  }
}

export async function replayMutationVersion(
  env: Env,
  command: KnowledgeMutationCommandRow,
  requestHash: string
) {
  if (command.request_hash !== requestHash) {
    throw new HttpError(409, "knowledge_idempotency_key_reused");
  }
  if (command.status !== "committed" || !command.version_after_id) {
    throw new HttpError(409, "knowledge_mutation_in_progress");
  }
  return requireVersion(env, command.version_after_id);
}

export function assertExpectedVersionForMutation(object: ObjectRow, mutation: KnowledgeMutationContext) {
  if (object.object_kind !== "file") {
    return;
  }
  if (!mutation.expectedVersionId) {
    throw new HttpError(428, "knowledge_expected_version_required");
  }
  if (mutation.expectedVersionId !== object.current_version_id) {
    throw new HttpError(409, "knowledge_version_conflict");
  }
}

export function mutationCommandGuardStatement(
  env: Env,
  input: {
    commandId: string;
    expectedVersionId: string;
    idempotencyKey: string;
    idempotencyScope: string;
    namespaceId: string;
    objectId: string;
    operation: string;
    orgId: string;
    requestHash: string;
    rootObjectId: string;
  }
) {
  return env.KNOWLEDGE_DB
    .prepare(
      `INSERT INTO knowledge_mutation_commands (
         id, org_id, namespace_id, root_object_id, object_id, operation,
         expected_version_id, idempotency_scope, idempotency_key, request_hash
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM knowledge_objects
       WHERE id = ? AND namespace_id = ? AND deleted_at IS NULL
         AND current_version_id = ?
       ON CONFLICT(idempotency_scope, idempotency_key) DO NOTHING`
    )
    .bind(
      input.commandId,
      input.orgId,
      input.namespaceId,
      input.rootObjectId,
      input.objectId,
      input.operation,
      input.expectedVersionId,
      input.idempotencyScope,
      input.idempotencyKey,
      input.requestHash,
      input.objectId,
      input.namespaceId,
      input.expectedVersionId
    );
}

export function changeAuditStatements(
  env: Env,
  input: {
    action: "rename" | "move" | "delete" | "restore" | "folder_create" | "folder_rename" | "folder_move" | "folder_delete";
    changeItemId: string;
    changeSetId: string;
    commandId: string;
    expectedVersionId: string;
    mutation: KnowledgeMutationContext;
    object: ObjectRow;
    operation: string;
    orgId: string;
    pathAfter: string;
    pathBefore: string;
    principal: Principal;
    rootObjectId: string;
    versionAfterId: string;
    versionBeforeId: string;
  }
) {
  const actorEmail = requiredKnowledgeActorEmail(input.principal);
  return [
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_change_sets (
           id, org_id, namespace_id, root_object_id, mutation_command_id, request_id,
           idempotency_scope, idempotency_key, actor_type, actor_user_id, actor_email,
           source_channel, operation, summary, item_count
         )
         SELECT ?, ?, ?, ?, command.id, ?, command.idempotency_scope, command.idempotency_key,
                ?, ?, ?, ?, ?, ?, 1
         FROM knowledge_mutation_commands AS command
         WHERE command.id = ? AND command.status = 'prepared'`
      )
      .bind(
        input.changeSetId,
        input.orgId,
        input.object.namespace_id,
        input.rootObjectId,
        input.mutation.requestId,
        input.mutation.sourceChannel === "mcp" ? "agent" : "user",
        input.principal.sub,
        actorEmail,
        input.mutation.sourceChannel,
        input.operation,
        `${input.operation} ${input.pathBefore}`,
        input.commandId
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_change_items (
           id, change_set_id, root_object_id, object_id, action,
           path_before, path_after, version_before_id, version_after_id,
           sha256_before, sha256_after, size_before, size_after,
           mime_type_before, mime_type_after, expected_version_id, diff_status
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_applicable'
         FROM knowledge_mutation_commands
         WHERE id = ? AND status = 'prepared'`
      )
      .bind(
        input.changeItemId,
        input.changeSetId,
        input.rootObjectId,
        input.object.id,
        input.action,
        input.pathBefore,
        input.pathAfter,
        input.versionBeforeId,
        input.versionAfterId,
        input.object.sha256,
        input.operation === "delete" ? "" : input.object.sha256,
        input.object.size_bytes,
        input.operation === "delete" ? 0 : input.object.size_bytes,
        input.object.mime_type,
        input.operation === "delete" ? "" : input.object.mime_type,
        input.expectedVersionId,
        input.commandId
      )
  ];
}

export function commitMetadataMutationStatement(
  env: Env,
  commandId: string,
  changeItemId: string,
  result: Record<string, unknown>
) {
  return env.KNOWLEDGE_DB
    .prepare(
      `UPDATE knowledge_mutation_commands
       SET status = 'committed', result_json = ?, committed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'prepared'
         AND EXISTS (SELECT 1 FROM knowledge_change_items WHERE id = ?)`
    )
    .bind(JSON.stringify(result), commandId, changeItemId);
}

export async function assertCommittedMutationReplay(
  command: KnowledgeMutationCommandRow | null,
  requestHash: string
) {
  if (!command) {
    throw new HttpError(409, "knowledge_version_conflict");
  }
  if (command.request_hash !== requestHash) {
    throw new HttpError(409, "knowledge_idempotency_key_reused");
  }
  if (command.status !== "committed") {
    throw new HttpError(409, "knowledge_mutation_in_progress");
  }
}

export function mutationDeleteResult(command: KnowledgeMutationCommandRow, objectId: string) {
  const result = safeJsonRecord(command.result_json);
  return {
    deletedBytes: Number(result.deletedBytes ?? 0),
    deletedCount: Number(result.deletedCount ?? 1),
    deletedObjectId: readString(result.deletedObjectId) || objectId
  };
}
