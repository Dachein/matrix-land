import { HttpError } from "../http.ts";
import type { Env, KnowledgeMutationContext, NamespaceRow, ObjectRow, Principal, VersionRow } from "../types.ts";
import { knowledgeV2Flags } from "../knowledge-v2-flags.ts";
import { requiredKnowledgeActorEmail } from "../identity.ts";
import { requireRootObjectForMutation } from "./repository.ts";
import { builtInKnowledgeIngestionDecision, isDiffableKnowledgeFile, sha256Text } from "./content.ts";
import { existingMutationCommand, existingMutationCommandSafely, replayMutationVersion } from "../mutations/commands.ts";
import { indexOutboxStatements } from "../mutations/indexOutbox.ts";
import { safeErrorName } from "../errors.ts";

// Only trusted server-side ingestion may supply an already-stored binary version.
export type StoredKnowledgeBinary = { versionId: string; r2Key: string; byteLength: number; sha256: string };
type VersionContent = Uint8Array | StoredKnowledgeBinary;

function storedContent(content: VersionContent, namespace: NamespaceRow, object: ObjectRow, sha256: string) {
  if (content instanceof Uint8Array) return undefined;
  if (!/^kov_[a-f0-9-]{36}$/.test(content.versionId)
    || content.r2Key !== `${namespace.r2_prefix}/objects/${object.id}/versions/${content.versionId}`
    || content.sha256 !== sha256 || !Number.isSafeInteger(content.byteLength) || content.byteLength <= 0)
    throw new HttpError(400, "knowledge_stored_binary_invalid");
  return content;
}

// Own version storage, quota accounting and commit-state reconciliation across R2 and D1.

export async function persistObjectVersion(
  env: Env,
  namespace: NamespaceRow,
  object: ObjectRow,
  principal: Principal,
  bytes: VersionContent,
  mimeType: string,
  contentKind: string,
  sha256: string,
  mutation?: KnowledgeMutationContext
) {
  if (!(bytes instanceof Uint8Array)) {
    storedContent(bytes, namespace, object, sha256);
    if (contentKind !== "binary") throw new HttpError(400, "knowledge_stored_content_must_be_binary");
  }
  if (knowledgeV2Flags(env).mutationSpine && mutation) {
    return persistObjectVersionV2(
      env,
      namespace,
      object,
      principal,
      bytes,
      mimeType,
      contentKind,
      sha256,
      mutation
    );
  }
  const stored = storedContent(bytes, namespace, object, sha256);
  const versionId = stored?.versionId ?? `kov_${crypto.randomUUID()}`;
  const r2Key = `${namespace.r2_prefix}/objects/${object.id}/versions/${versionId}`;
  if (bytes instanceof Uint8Array) await env.KNOWLEDGE_OBJECTS.put(r2Key, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { objectId: object.id, namespaceId: namespace.id, sha256, versionId }
  });
  const ingestion = bytes instanceof Uint8Array
    ? builtInKnowledgeIngestionDecision(object.file_name, mimeType, bytes)
    : { reasonCode: "external_scanner_required", status: "pending" as const };

  try {
    await env.KNOWLEDGE_DB.batch([
      env.KNOWLEDGE_DB
        .prepare(
          `
          INSERT INTO knowledge_object_versions (
            id, object_id, namespace_id, version, r2_key, mime_type, size_bytes, sha256, created_by_user_id
          )
          SELECT
            ?, ?, ?,
            (SELECT COALESCE(MAX(version), 0) + 1 FROM knowledge_object_versions WHERE object_id = ?),
            ?, ?, ?, ?, ?
          FROM knowledge_namespaces AS namespace
          WHERE namespace.id = ?
            AND EXISTS (
              SELECT 1 FROM knowledge_objects
              WHERE id = ? AND namespace_id = namespace.id AND object_kind = 'file' AND deleted_at IS NULL
            )
            AND (
              namespace.quota_bytes <= 0
              OR MAX(
                0,
                namespace.used_bytes + ? - COALESCE((
                  SELECT size_bytes FROM knowledge_objects WHERE id = ? AND deleted_at IS NULL
                ), 0)
              ) <= namespace.quota_bytes
            )
          `
        )
        .bind(
          versionId,
          object.id,
          namespace.id,
          object.id,
          r2Key,
          mimeType,
          bytes.byteLength,
          sha256,
          principal.sub,
          namespace.id,
          object.id,
          bytes.byteLength,
          object.id
        ),
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_ingestion_states (
             object_id, version_id, scan_status, scanner_version, reason_code, scanned_at
           )
           SELECT ?, ?, ?, 'builtin-policy-v1', ?,
                  CASE WHEN ? IN ('clean', 'blocked') THEN CURRENT_TIMESTAMP ELSE NULL END
           WHERE EXISTS (SELECT 1 FROM knowledge_object_versions WHERE id = ?)`
        )
        .bind(
          object.id,
          versionId,
          ingestion.status,
          ingestion.reasonCode,
          ingestion.status,
          versionId
        ),
      env.KNOWLEDGE_DB
        .prepare(
          `
          UPDATE knowledge_namespaces
          SET used_bytes = MAX(
                0,
                used_bytes + ? - COALESCE((
                  SELECT size_bytes FROM knowledge_objects WHERE id = ? AND deleted_at IS NULL
                ), 0)
              ),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND EXISTS (SELECT 1 FROM knowledge_object_versions WHERE id = ?)
          `
        )
        .bind(bytes.byteLength, object.id, namespace.id, versionId),
      env.KNOWLEDGE_DB
        .prepare(
          `
          UPDATE knowledge_objects
          SET current_version_id = ?, mime_type = ?, content_kind = ?, size_bytes = ?, sha256 = ?,
              updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM knowledge_object_versions WHERE id = ?)
          `
        )
        .bind(versionId, mimeType, contentKind, bytes.byteLength, sha256, principal.sub, object.id, versionId)
    ]);
  } catch (batchError) {
    let committedVersion: VersionRow | null;
    try {
      committedVersion = await env.KNOWLEDGE_DB
        .prepare("SELECT * FROM knowledge_object_versions WHERE id = ?")
        .bind(versionId)
        .first<VersionRow>();
    } catch (lookupError) {
      // A failed batch response does not prove that D1 rolled back. If the
      // commit-state lookup also fails, deleting R2 could corrupt a committed
      // version. Preserve the object and log only opaque identifiers and error
      // classes so operators can reconcile it without leaking request data.
      console.error("knowledge_object_version_commit_state_unknown", {
        batchErrorName: safeErrorName(batchError),
        lookupErrorName: safeErrorName(lookupError),
        versionId
      });
      throw batchError;
    }

    if (committedVersion) {
      return committedVersion;
    }

    await compensateR2VersionWrite(env, r2Key, batchError);
    throw batchError;
  }

  const version = await env.KNOWLEDGE_DB.prepare("SELECT * FROM knowledge_object_versions WHERE id = ?").bind(versionId).first<VersionRow>();
  if (!version) {
    await compensateR2VersionWrite(env, r2Key, new Error("knowledge_namespace_quota_exceeded"));
    throw new HttpError(413, "knowledge_namespace_quota_exceeded");
  }
  return version;
}

async function persistObjectVersionV2(
  env: Env,
  namespace: NamespaceRow,
  object: ObjectRow,
  principal: Principal,
  bytes: VersionContent,
  mimeType: string,
  contentKind: string,
  sha256: string,
  mutation: KnowledgeMutationContext
) {
  const actorEmail = requiredKnowledgeActorEmail(principal);
  const creating = !object.current_version_id;
  if (!creating && !mutation.expectedVersionId) {
    throw new HttpError(428, "knowledge_expected_version_required");
  }
  if (!creating && mutation.expectedVersionId !== object.current_version_id) {
    throw new HttpError(409, "knowledge_version_conflict");
  }
  const root = await requireRootObjectForMutation(env, object);
  const operation = creating
    ? "create"
    : mutation.operation === "edit"
      ? "edit"
      : mutation.operation === "restore_version"
        ? "restore"
        : "update";
  const idempotencyScope = `${principal.orgId}:${principal.sub}:${root.id}:${operation}`;
  const requestHash = await sha256Text(JSON.stringify({
    contentKind,
    expectedVersionId: mutation.expectedVersionId,
    mimeType,
    objectId: object.id,
    operation,
    path: object.path,
    sha256,
    sizeBytes: bytes.byteLength
  }));
  const replay = await existingMutationCommand(env, idempotencyScope, mutation.idempotencyKey);
  if (replay) {
    return replayMutationVersion(env, replay, requestHash);
  }

  const stored = storedContent(bytes, namespace, object, sha256);
  const versionId = stored?.versionId ?? `kov_${crypto.randomUUID()}`;
  const commandId = `kmut_${crypto.randomUUID()}`;
  const changeSetId = `kchg_${crypto.randomUUID()}`;
  const changeItemId = `kchi_${crypto.randomUUID()}`;
  const diffOutboxId = `kdiff_${crypto.randomUUID()}`;
  const indexOutboxPrefix = `kidx_${crypto.randomUUID()}`;
  const r2Key = `${namespace.r2_prefix}/objects/${object.id}/versions/${versionId}`;
  const expectedVersionId = creating ? "" : mutation.expectedVersionId;
  const diffStatus = creating || !isDiffableKnowledgeFile(object.file_name, mimeType)
    ? "not_applicable"
    : "pending";
  const ingestion = bytes instanceof Uint8Array
    ? builtInKnowledgeIngestionDecision(object.file_name, mimeType, bytes)
    : { reasonCode: "external_scanner_required", status: "pending" as const };
  const resultJson = JSON.stringify({ changeSetId, objectId: object.id, versionId });

  if (bytes instanceof Uint8Array) await env.KNOWLEDGE_OBJECTS.put(r2Key, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { objectId: object.id, namespaceId: namespace.id, sha256, versionId }
  });

  const statements: D1PreparedStatement[] = [
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_mutation_commands (
           id, org_id, namespace_id, root_object_id, object_id, operation,
           expected_version_id, idempotency_scope, idempotency_key, request_hash
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM knowledge_objects
         WHERE id = ? AND namespace_id = ? AND deleted_at IS NULL
           AND current_version_id = ?
           AND EXISTS (
             SELECT 1 FROM knowledge_namespaces AS namespace
             WHERE namespace.id = ?
               AND (
                 namespace.quota_bytes <= 0
                 OR MAX(0, namespace.used_bytes + ? - knowledge_objects.size_bytes) <= namespace.quota_bytes
               )
           )
         ON CONFLICT(idempotency_scope, idempotency_key) DO NOTHING`
      )
      .bind(
        commandId,
        principal.orgId,
        namespace.id,
        root.id,
        object.id,
        operation,
        expectedVersionId,
        idempotencyScope,
        mutation.idempotencyKey,
        requestHash,
        object.id,
        namespace.id,
        expectedVersionId,
        namespace.id,
        bytes.byteLength
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_object_versions (
           id, object_id, namespace_id, version, r2_key, mime_type, size_bytes, sha256, created_by_user_id
         )
         SELECT ?, ?, ?,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM knowledge_object_versions WHERE object_id = ?),
           ?, ?, ?, ?, ?
         FROM knowledge_mutation_commands
         WHERE id = ? AND status = 'prepared'`
      )
      .bind(
        versionId,
        object.id,
        namespace.id,
        object.id,
        r2Key,
        mimeType,
        bytes.byteLength,
        sha256,
        principal.sub,
        commandId
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_ingestion_states (
           object_id, version_id, scan_status, scanner_version, reason_code, scanned_at
         )
         SELECT ?, ?, ?, 'builtin-policy-v1', ?,
                CASE WHEN ? IN ('clean', 'blocked') THEN CURRENT_TIMESTAMP ELSE NULL END
         FROM knowledge_mutation_commands
         WHERE id = ? AND status = 'prepared'`
      )
      .bind(
        object.id,
        versionId,
        ingestion.status,
        ingestion.reasonCode,
        ingestion.status,
        commandId
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_namespaces
         SET used_bytes = MAX(
               0,
               used_bytes + ? - COALESCE((
                 SELECT size_bytes FROM knowledge_objects WHERE id = ? AND deleted_at IS NULL
               ), 0)
             ),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND EXISTS (SELECT 1 FROM knowledge_object_versions WHERE id = ?)`
      )
      .bind(bytes.byteLength, object.id, namespace.id, versionId),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_objects
         SET current_version_id = ?, mime_type = ?, content_kind = ?, size_bytes = ?, sha256 = ?,
             updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND namespace_id = ? AND deleted_at IS NULL
           AND current_version_id = ?
           AND EXISTS (SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared')`
      )
      .bind(
        versionId,
        mimeType,
        contentKind,
        bytes.byteLength,
        sha256,
        principal.sub,
        object.id,
        namespace.id,
        expectedVersionId,
        commandId
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_change_sets (
           id, org_id, namespace_id, root_object_id, mutation_command_id, request_id,
           idempotency_scope, idempotency_key, actor_type, actor_user_id, actor_email,
           source_channel, operation, summary, item_count
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
         FROM knowledge_mutation_commands
         WHERE id = ? AND status = 'prepared'`
      )
      .bind(
        changeSetId,
        principal.orgId,
        namespace.id,
        root.id,
        commandId,
        mutation.requestId,
        idempotencyScope,
        mutation.idempotencyKey,
        mutation.sourceChannel === "mcp" ? "agent" : "user",
        principal.sub,
        actorEmail,
        mutation.sourceChannel,
        operation,
        `${operation} ${object.path}`,
        commandId
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_change_items (
           id, change_set_id, root_object_id, object_id, action, edit_operation, path_before, path_after,
           version_before_id, version_after_id, sha256_before, sha256_after,
           size_before, size_after, mime_type_before, mime_type_after,
           expected_version_id, diff_status
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM knowledge_mutation_commands
         WHERE id = ? AND status = 'prepared'`
      )
      .bind(
        changeItemId,
        changeSetId,
        root.id,
        object.id,
        operation,
        mutation.editOperation ?? "",
        creating ? "" : object.path,
        object.path,
        object.current_version_id,
        versionId,
        object.sha256,
        sha256,
        object.size_bytes,
        bytes.byteLength,
        object.mime_type,
        mimeType,
        expectedVersionId,
        diffStatus,
        commandId
      )
  ];
  if (diffStatus === "pending") {
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_diff_outbox (id, change_item_id)
           SELECT ?, ?
           FROM knowledge_mutation_commands
           WHERE id = ? AND status = 'prepared'`
        )
        .bind(diffOutboxId, changeItemId, commandId)
    );
  }
  statements.push(
    ...indexOutboxStatements(
      env,
      object,
      changeSetId,
      versionId,
      operation === "create" || operation === "update" || operation === "edit" ? "upsert" : "reextract",
      indexOutboxPrefix,
      commandId
    ),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_mutation_commands
         SET status = 'committed', version_after_id = ?, result_json = ?,
             committed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'prepared'
           AND EXISTS (SELECT 1 FROM knowledge_change_items WHERE id = ?)
           AND EXISTS (SELECT 1 FROM knowledge_object_versions WHERE id = ?)`
      )
      .bind(versionId, resultJson, commandId, changeItemId, versionId)
  );

  try {
    await env.KNOWLEDGE_DB.batch(statements);
  } catch (batchError) {
    const committed = await existingMutationCommandSafely(env, idempotencyScope, mutation.idempotencyKey, batchError);
    if (committed?.status === "committed") {
      return replayMutationVersion(env, committed, requestHash);
    }
    if (!committed) {
      await compensateR2VersionWrite(env, r2Key, batchError);
    }
    throw batchError;
  }

  const committed = await existingMutationCommand(env, idempotencyScope, mutation.idempotencyKey);
  if (!committed) {
    await compensateR2VersionWrite(env, r2Key, new Error("knowledge_version_conflict"));
    if (await knowledgeQuotaWouldBeExceeded(env, namespace.id, object.id, bytes.byteLength)) {
      throw new HttpError(413, "knowledge_namespace_quota_exceeded");
    }
    throw new HttpError(409, "knowledge_version_conflict");
  }
  if (committed.request_hash !== requestHash) {
    await compensateR2VersionWrite(env, r2Key, new Error("knowledge_idempotency_key_reused"));
    throw new HttpError(409, "knowledge_idempotency_key_reused");
  }
  if (committed.status !== "committed") {
    await compensateR2VersionWrite(env, r2Key, new Error("knowledge_mutation_not_committed"));
    throw new HttpError(409, "knowledge_mutation_not_committed");
  }
  if (committed.version_after_id !== versionId) {
    await compensateR2VersionWrite(env, r2Key, new Error("knowledge_mutation_replayed"));
  }
  return replayMutationVersion(env, committed, requestHash);
}

async function knowledgeQuotaWouldBeExceeded(
  env: Env,
  namespaceId: string,
  objectId: string,
  nextSizeBytes: number
) {
  const row = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT CASE
         WHEN namespace.quota_bytes > 0
          AND MAX(0, namespace.used_bytes + ? - COALESCE(object.size_bytes, 0)) > namespace.quota_bytes
         THEN 1 ELSE 0 END AS exceeded
       FROM knowledge_namespaces AS namespace
       LEFT JOIN knowledge_objects AS object ON object.id = ? AND object.namespace_id = namespace.id
       WHERE namespace.id = ?`
    )
    .bind(nextSizeBytes, objectId, namespaceId)
    .first<{ exceeded: number }>();
  return row?.exceeded === 1;
}

export async function compensateR2VersionWrite(env: Env, r2Key: string, cause: unknown) {
  try {
    await env.KNOWLEDGE_OBJECTS.delete(r2Key);
  } catch (cleanupError) {
    console.error("knowledge_r2_version_compensation_failed", {
      causeName: safeErrorName(cause),
      cleanupErrorName: safeErrorName(cleanupError),
      r2Key
    });
  }
}

export async function cleanupEmptyFileObject(env: Env, objectId: string, cause: unknown) {
  try {
    await env.KNOWLEDGE_DB
      .prepare(
        `DELETE FROM knowledge_objects
         WHERE id = ? AND current_version_id = '' AND size_bytes = 0
           AND NOT EXISTS (SELECT 1 FROM knowledge_object_versions WHERE object_id = ?)`
      )
      .bind(objectId, objectId)
      .run();
  } catch (cleanupError) {
    console.error("knowledge_empty_file_compensation_failed", {
      causeName: safeErrorName(cause),
      cleanupErrorName: safeErrorName(cleanupError),
      objectId
    });
  }
}
