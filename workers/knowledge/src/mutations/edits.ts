import { processKnowledgeDiffOutbox, processKnowledgeDiffOutboxAfterMutation } from "../audit/diffs.ts";
import { HttpError } from "../http.ts";
import { requiredKnowledgeActorEmail } from "../identity.ts";
import { dispatchKnowledgeIndexOutboxAfterMutation } from "../indexing/outbox.ts";
import { knowledgeV2Flags } from "../knowledge-v2-flags.ts";
import { assertObjectMutationAllowed, requireWritableObject } from "../objects/access.ts";
import { isDirectlyEditableKnowledgeFile, sha256Hex, sha256Text, validateDirectEditContent } from "../objects/content.ts";
import { requireCurrentVersion, requireNamespaceForPrincipal, requireRootObjectForMutation } from "../objects/repository.ts";
import { compensateR2VersionWrite, persistObjectVersion } from "../objects/versions.ts";
import { effectiveKnowledgePolicy } from "../policy.ts";
import { applyUnifiedTextPatch } from "../textPatch.ts";
import type { Env, KnowledgeMutationContext, NamespaceRow, ObjectRow, Principal, VersionRow } from "../types.ts";
import { readString, safeJsonRecord } from "../values.ts";
import {
  assertCommittedMutationReplay,
  assertExpectedVersionForMutation,
  existingMutationCommand,
  existingMutationCommandSafely
} from "./commands.ts";
import { normalizeKnowledgeIdempotencyKey, requireArgString } from "./context.ts";
import { indexOutboxStatements } from "./indexOutbox.ts";

export async function editKnowledgeFile(
  env: Env,
  namespace: NamespaceRow,
  object: ObjectRow,
  principal: Principal,
  body: Record<string, unknown>,
  mutation: KnowledgeMutationContext
) {
  if (!knowledgeV2Flags(env).mutationSpine) {
    throw new HttpError(503, "knowledge_edit_requires_mutation_spine");
  }
  if (object.object_kind !== "file") {
    throw new HttpError(400, "folder_not_editable");
  }
  if (!isDirectlyEditableKnowledgeFile(object.file_name, object.mime_type)) {
    throw new HttpError(415, "knowledge_file_format_not_editable");
  }
  assertExpectedVersionForMutation(object, mutation);
  const currentVersion = await requireCurrentVersion(env, object);
  if (currentVersion.size_bytes > effectiveKnowledgePolicy(env).limits.textIndexBytes) {
    throw new HttpError(413, "knowledge_edit_file_too_large");
  }
  const r2Object = await env.KNOWLEDGE_OBJECTS.get(currentVersion.r2_key);
  if (!r2Object) {
    throw new HttpError(404, "knowledge_object_missing");
  }
  let before: string;
  try {
    before = new TextDecoder("utf-8", { fatal: true }).decode(await r2Object.arrayBuffer());
  } catch {
    throw new HttpError(415, "knowledge_file_not_utf8");
  }
  const operation = readString(body.operation).trim();
  const after = applyKnowledgeTextEdit(before, body);
  const bytes = new TextEncoder().encode(after);
  if (bytes.byteLength === 0) {
    throw new HttpError(400, "empty_file");
  }
  if (bytes.byteLength > effectiveKnowledgePolicy(env).limits.fileBytes) {
    throw new HttpError(413, "knowledge_file_too_large");
  }
  validateDirectEditContent(object.file_name, after);
  const sha256 = await sha256Hex(bytes);
  const version = await persistObjectVersion(
    env,
    namespace,
    object,
    principal,
    bytes,
    currentVersion.mime_type || object.mime_type,
    object.content_kind,
    sha256,
    { ...mutation, editOperation: operation }
  );
  await processKnowledgeDiffOutboxAfterMutation(env, version.id);
  await dispatchKnowledgeIndexOutboxAfterMutation(env);
  const changeItem = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT item.*, change_set.id AS resolved_change_set_id
       FROM knowledge_change_items AS item
       JOIN knowledge_change_sets AS change_set ON change_set.id = item.change_set_id
       WHERE item.version_after_id = ?
       ORDER BY item.created_at DESC
       LIMIT 1`
    )
    .bind(version.id)
    .first<Record<string, unknown>>();
  return {
    changeItemId: readString(changeItem?.id),
    changeSetId: readString(changeItem?.resolved_change_set_id),
    diffStatus: readString(changeItem?.diff_status),
    objectId: object.id,
    operation,
    versionAfterId: version.id,
    versionBeforeId: currentVersion.id
  };
}

export async function editKnowledgeBatch(
  env: Env,
  principal: Principal,
  body: Record<string, unknown>,
  mutation: KnowledgeMutationContext
) {
  if (!knowledgeV2Flags(env).mutationSpine) {
    throw new HttpError(503, "knowledge_edit_requires_mutation_spine");
  }
  const actorEmail = requiredKnowledgeActorEmail(principal);
  if (body.allOrNothing === false || body.all_or_nothing === false) {
    throw new HttpError(400, "knowledge_batch_requires_all_or_nothing");
  }
  const rawItems = body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new HttpError(400, "knowledge_batch_items_required");
  }
  if (rawItems.length > 20) {
    throw new HttpError(400, "knowledge_batch_too_many_items");
  }
  const prepared: Array<{
    afterBytes: Uint8Array;
    afterSha256: string;
    changeItemId: string;
    diffOutboxId: string;
    expectedVersionId: string;
    mutationItem: Record<string, unknown>;
    namespace: NamespaceRow;
    object: ObjectRow;
    operation: string;
    r2Key: string;
    version: VersionRow;
    versionId: string;
  }> = [];
  let root: ObjectRow | undefined;
  let namespace: NamespaceRow | undefined;
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      throw new HttpError(400, "invalid_knowledge_batch_item");
    }
    const item = rawItem as Record<string, unknown>;
    const object = await requireWritableObject(
      env,
      principal,
      requireArgString(item.objectId ?? item.object_id, "knowledge_batch_object_id_required")
    );
    const itemNamespace = await requireNamespaceForPrincipal(env, object.namespace_id, principal);
    await assertObjectMutationAllowed(env, itemNamespace, object, principal, "content");
    if (object.object_kind !== "file" || !isDirectlyEditableKnowledgeFile(object.file_name, object.mime_type)) {
      throw new HttpError(415, "knowledge_file_format_not_editable");
    }
    const expectedVersionId = readString(item.expectedCurrentVersionId ?? item.expected_current_version_id);
    assertExpectedVersionForMutation(object, {
      ...mutation,
      expectedVersionId
    });
    const itemRoot = await requireRootObjectForMutation(env, object);
    if (root && itemRoot.id !== root.id) {
      throw new HttpError(400, "knowledge_batch_single_root_required");
    }
    if (namespace && itemNamespace.id !== namespace.id) {
      throw new HttpError(400, "knowledge_batch_single_root_required");
    }
    root = itemRoot;
    namespace = itemNamespace;
    const currentVersion = await requireCurrentVersion(env, object);
    if (currentVersion.size_bytes > effectiveKnowledgePolicy(env).limits.textIndexBytes) {
      throw new HttpError(413, "knowledge_edit_file_too_large");
    }
    const r2Object = await env.KNOWLEDGE_OBJECTS.get(currentVersion.r2_key);
    if (!r2Object) {
      throw new HttpError(404, "knowledge_object_missing");
    }
    let before: string;
    try {
      before = new TextDecoder("utf-8", { fatal: true }).decode(await r2Object.arrayBuffer());
    } catch {
      throw new HttpError(415, "knowledge_file_not_utf8");
    }
    const after = applyKnowledgeTextEdit(before, item);
    validateDirectEditContent(object.file_name, after);
    const afterBytes = new TextEncoder().encode(after);
    if (afterBytes.byteLength === 0 || afterBytes.byteLength > effectiveKnowledgePolicy(env).limits.fileBytes) {
      throw new HttpError(afterBytes.byteLength === 0 ? 400 : 413, afterBytes.byteLength === 0 ? "empty_file" : "knowledge_file_too_large");
    }
    const versionId = `kov_${crypto.randomUUID()}`;
    prepared.push({
      afterBytes,
      afterSha256: await sha256Hex(afterBytes),
      changeItemId: `kchi_${crypto.randomUUID()}`,
      diffOutboxId: `kdiff_${crypto.randomUUID()}`,
      expectedVersionId,
      mutationItem: item,
      namespace: itemNamespace,
      object,
      operation: readString(item.operation),
      r2Key: `${itemNamespace.r2_prefix}/objects/${object.id}/versions/${versionId}`,
      version: currentVersion,
      versionId
    });
  }
  if (!root || !namespace) {
    throw new HttpError(400, "knowledge_batch_items_required");
  }
  const idempotencyKey = normalizeKnowledgeIdempotencyKey(body.idempotencyKey) ?? mutation.idempotencyKey;
  const idempotencyScope = `${principal.orgId}:${principal.sub}:${root.id}:batch_edit`;
  const requestHash = await sha256Text(JSON.stringify(prepared.map((item) => ({
    expectedVersionId: item.expectedVersionId,
    objectId: item.object.id,
    operation: item.operation,
    sha256: item.afterSha256
  }))));
  const replay = await existingMutationCommand(env, idempotencyScope, idempotencyKey);
  if (replay) {
    await assertCommittedMutationReplay(replay, requestHash);
    return safeJsonRecord(replay.result_json);
  }
  const commandId = `kmut_${crypto.randomUUID()}`;
  const changeSetId = `kchg_${crypto.randomUUID()}`;
  const indexOutboxPrefix = `kidx_${crypto.randomUUID()}`;
  const stagedKeys: string[] = [];
  try {
    for (const item of prepared) {
      await env.KNOWLEDGE_OBJECTS.put(item.r2Key, item.afterBytes, {
        httpMetadata: { contentType: item.version.mime_type || item.object.mime_type },
        customMetadata: {
          objectId: item.object.id,
          namespaceId: namespace.id,
          sha256: item.afterSha256,
          versionId: item.versionId
        }
      });
      stagedKeys.push(item.r2Key);
    }
  } catch (error) {
    for (const key of stagedKeys) {
      await compensateR2VersionWrite(env, key, error);
    }
    throw new HttpError(502, "knowledge_batch_staging_failed");
  }
  const casConditions = prepared.map(
    () => "EXISTS (SELECT 1 FROM knowledge_objects item WHERE item.id = ? AND item.namespace_id = ? AND item.current_version_id = ? AND item.deleted_at IS NULL)"
  );
  const quotaDelta = prepared.reduce(
    (sum, item) => sum + item.afterBytes.byteLength - item.object.size_bytes,
    0
  );
  const guardBindings = prepared.flatMap((item) => [
    item.object.id,
    namespace.id,
    item.expectedVersionId
  ]);
  const statements: D1PreparedStatement[] = [
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_mutation_commands (
           id, org_id, namespace_id, root_object_id, object_id, operation,
           expected_version_id, idempotency_scope, idempotency_key, request_hash
         )
         SELECT ?, ?, ?, ?, ?, 'batch_edit', '', ?, ?, ?
         FROM knowledge_objects AS root
         JOIN knowledge_namespaces AS namespace ON namespace.id = root.namespace_id
         WHERE root.id = ? AND root.deleted_at IS NULL
           AND ${casConditions.join(" AND ")}
           AND (namespace.quota_bytes <= 0 OR MAX(0, namespace.used_bytes + ?) <= namespace.quota_bytes)
         ON CONFLICT(idempotency_scope, idempotency_key) DO NOTHING`
      )
      .bind(
        commandId,
        principal.orgId,
        namespace.id,
        root.id,
        root.id,
        idempotencyScope,
        idempotencyKey,
        requestHash,
        root.id,
        ...guardBindings,
        quotaDelta
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_change_sets (
           id, org_id, namespace_id, root_object_id, mutation_command_id, request_id,
           idempotency_scope, idempotency_key, actor_type, actor_user_id, actor_email,
           source_channel, operation, summary, item_count
         )
         SELECT ?, ?, ?, ?, id, ?, idempotency_scope, idempotency_key,
                ?, ?, ?, ?, 'batch_edit', ?, ?
         FROM knowledge_mutation_commands
         WHERE id = ? AND status = 'prepared'`
      )
      .bind(
        changeSetId,
        principal.orgId,
        namespace.id,
        root.id,
        mutation.requestId,
        mutation.sourceChannel === "mcp" ? "agent" : "user",
        principal.sub,
        actorEmail,
        mutation.sourceChannel,
        `batch_edit ${prepared.length} files`,
        prepared.length,
        commandId
      )
  ];
  for (const item of prepared) {
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_object_versions (
             id, object_id, namespace_id, version, r2_key, mime_type,
             size_bytes, sha256, created_by_user_id
           )
           SELECT ?, ?, ?,
             (SELECT COALESCE(MAX(version), 0) + 1 FROM knowledge_object_versions WHERE object_id = ?),
             ?, ?, ?, ?, ?
           FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'`
        )
        .bind(
          item.versionId,
          item.object.id,
          namespace.id,
          item.object.id,
          item.r2Key,
          item.version.mime_type || item.object.mime_type,
          item.afterBytes.byteLength,
          item.afterSha256,
          principal.sub,
          commandId
        ),
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_ingestion_states (
             object_id, version_id, scan_status, scanner_version, reason_code, scanned_at
           )
           SELECT ?, ?, 'clean', 'builtin-policy-v1', 'builtin_utf8_text', CURRENT_TIMESTAMP
           FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'`
        )
        .bind(item.object.id, item.versionId, commandId),
      env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_objects
           SET current_version_id = ?, size_bytes = ?, sha256 = ?,
               updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND current_version_id = ?
             AND EXISTS (SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared')`
        )
        .bind(
          item.versionId,
          item.afterBytes.byteLength,
          item.afterSha256,
          principal.sub,
          item.object.id,
          item.expectedVersionId,
          commandId
        ),
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_change_items (
             id, change_set_id, root_object_id, object_id, action, edit_operation,
             path_before, path_after, version_before_id, version_after_id,
             sha256_before, sha256_after, size_before, size_after,
             mime_type_before, mime_type_after, expected_version_id, diff_status
           )
           SELECT ?, ?, ?, ?, 'edit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
           FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'`
        )
        .bind(
          item.changeItemId,
          changeSetId,
          root.id,
          item.object.id,
          item.operation,
          item.object.path,
          item.object.path,
          item.version.id,
          item.versionId,
          item.object.sha256,
          item.afterSha256,
          item.object.size_bytes,
          item.afterBytes.byteLength,
          item.object.mime_type,
          item.version.mime_type || item.object.mime_type,
          item.expectedVersionId,
          commandId
        ),
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_diff_outbox (id, change_item_id)
           SELECT ?, ? FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'`
        )
        .bind(item.diffOutboxId, item.changeItemId, commandId)
    );
  }
  statements.push(
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_namespaces
         SET used_bytes = MAX(0, used_bytes + ?), updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM knowledge_mutation_commands WHERE id = ? AND status = 'prepared'
         )`
      )
      .bind(quotaDelta, namespace.id, commandId),
    ...indexOutboxStatements(
      env,
      root,
      changeSetId,
      "",
      "backfill",
      indexOutboxPrefix,
      commandId
    )
  );
  const result = {
    changeSetId,
    itemCount: prepared.length,
    items: prepared.map((item) => ({
      changeItemId: item.changeItemId,
      objectId: item.object.id,
      versionAfterId: item.versionId,
      versionBeforeId: item.version.id
    }))
  };
  statements.push(
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_mutation_commands
         SET status = 'committed', result_json = ?, committed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'prepared'
           AND (SELECT COUNT(*) FROM knowledge_change_items WHERE change_set_id = ?) = ?`
      )
      .bind(JSON.stringify(result), commandId, changeSetId, prepared.length)
  );
  try {
    await env.KNOWLEDGE_DB.batch(statements);
  } catch (error) {
    const committed = await existingMutationCommandSafely(env, idempotencyScope, idempotencyKey, error);
    if (committed?.status === "committed") {
      return safeJsonRecord(committed.result_json);
    }
    if (!committed) {
      for (const key of stagedKeys) {
        await compensateR2VersionWrite(env, key, error);
      }
    }
    throw error;
  }
  const committed = await existingMutationCommand(env, idempotencyScope, idempotencyKey);
  if (!committed) {
    for (const key of stagedKeys) {
      await compensateR2VersionWrite(env, key, new Error("knowledge_batch_conflict"));
    }
    throw new HttpError(409, "knowledge_batch_conflict");
  }
  await assertCommittedMutationReplay(committed, requestHash);
  for (const item of prepared) {
    await processKnowledgeDiffOutbox(env, 1, item.versionId);
  }
  await processKnowledgeDiffOutbox(env, 1);
  await dispatchKnowledgeIndexOutboxAfterMutation(env);
  return result;
}

function applyKnowledgeTextEdit(before: string, body: Record<string, unknown>) {
  const operation = readString(body.operation).trim();
  let after: string;
  if (operation === "replace_text") {
    const oldText = readString(body.oldText ?? body.old_text);
    const newText = readString(body.newText ?? body.new_text);
    if (!oldText) {
      throw new HttpError(400, "knowledge_edit_old_text_required");
    }
    const expectedOccurrences = Math.max(1, Math.min(100, Number(body.expectedOccurrences ?? body.expected_occurrences ?? 1)));
    const occurrences = countExactOccurrences(before, oldText);
    if (occurrences !== expectedOccurrences) {
      throw new HttpError(409, "knowledge_edit_occurrence_mismatch");
    }
    after = before.split(oldText).join(newText);
  } else if (operation === "append_text") {
    const text = readString(body.text ?? body.contentText);
    if (!text) {
      throw new HttpError(400, "knowledge_edit_text_required");
    }
    after = `${before}${text}`;
  } else if (operation === "replace_content") {
    after = readString(body.contentText ?? body.text);
  } else if (operation === "apply_patch") {
    const patch = readString(body.patch ?? body.patchText ?? body.text);
    if (!patch) {
      throw new HttpError(400, "knowledge_edit_patch_required");
    }
    after = applyUnifiedTextPatch(before, patch);
  } else {
    throw new HttpError(400, "invalid_knowledge_edit_operation");
  }
  return after;
}


function countExactOccurrences(source: string, needle: string) {
  let count = 0;
  let offset = 0;
  while (offset <= source.length - needle.length) {
    const index = source.indexOf(needle, offset);
    if (index < 0) {
      break;
    }
    count += 1;
    offset = index + needle.length;
  }
  return count;
}
