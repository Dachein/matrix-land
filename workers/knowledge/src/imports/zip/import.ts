import { safeErrorMessage, safeErrorName } from "../../errors.ts";
import { HttpError } from "../../http.ts";
import { requiredKnowledgeActorEmail } from "../../identity.ts";
import { dispatchKnowledgeIndexOutboxAfterMutation } from "../../indexing/outbox.ts";
import { knowledgeV2Flags } from "../../knowledge-v2-flags.ts";
import { commitMetadataMutationStatement, mutationCommandGuardStatement } from "../../mutations/commands.ts";
import { normalizeKnowledgeIdempotencyKey } from "../../mutations/context.ts";
import { indexOutboxStatements } from "../../mutations/indexOutbox.ts";
import { builtInKnowledgeIngestionDecision, sha256Hex, sha256Text } from "../../objects/content.ts";
import { requireRootObjectForMutation } from "../../objects/repository.ts";
import { joinPath, normalizePath, validateFolderName } from "../../paths.ts";
import { effectiveKnowledgePolicy } from "../../policy.ts";
import { markKnowledgeServicesStaleForPath } from "../../services/invalidation.ts";
import type { Env, KnowledgeMutationContext, KnowledgeZipImportJobRow, NamespaceRow, ObjectRow, Principal } from "../../types.ts";
import { archiveFolderName, buildKnowledgeZipImportPlan, ignoredZipEntry, normalizeZipEntryPath } from "./archive.ts";
import { cleanupKnowledgeZipStagingPrefix, failKnowledgeZipImportAndCleanup } from "./cleanup.ts";
import {
  assertKnowledgeZipImportPreflight,
  assertMatchingKnowledgeZipImport,
  beginKnowledgeZipImportJob,
  knowledgeZipImportJobById,
  knowledgeZipImportJobByKey,
  knowledgeZipImportResult
} from "./jobs.ts";
import { unzipSync } from "fflate";

export async function uploadZipArchive(
  env: Env,
  namespace: NamespaceRow,
  principal: Principal,
  parentPath: string,
  zipFileName: string,
  bytes: Uint8Array,
  mutation: KnowledgeMutationContext
) {
  const actorEmail = knowledgeV2Flags(env).mutationSpine
    ? requiredKnowledgeActorEmail(principal)
    : "";
  let entries: Record<string, Uint8Array>;
  let declaredEntryCount = 0;
  let declaredUncompressedBytes = 0;
  const declaredPaths = new Map<string, "file" | "folder">();
  try {
    entries = unzipSync(bytes, {
      filter(entry) {
        declaredEntryCount += 1;
        if (declaredEntryCount > effectiveKnowledgePolicy(env).limits.zipEntries) {
          throw new HttpError(413, "zip_too_many_entries");
        }
        if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
          throw new HttpError(400, "invalid_zip_archive");
        }
        declaredUncompressedBytes += entry.originalSize;
        if (declaredUncompressedBytes > effectiveKnowledgePolicy(env).limits.zipUncompressedBytes) {
          throw new HttpError(413, "zip_uncompressed_size_too_large");
        }
        // unzipSync returns a map and would silently overwrite identical entry names.
        const path = normalizeZipEntryPath(entry.name);
        if (!path) {
          throw new HttpError(400, "invalid_zip_entry_path");
        }
        if (!ignoredZipEntry(path)) {
          const kind = entry.name.endsWith("/") || entry.name.endsWith("\\") ? "folder" : "file";
          const previousKind = declaredPaths.get(path);
          if (previousKind) {
            throw new HttpError(409, previousKind === kind ? "knowledge_zip_duplicate_path" : "knowledge_zip_file_folder_conflict");
          }
          declaredPaths.set(path, kind);
          if (kind === "file" && entry.originalSize > effectiveKnowledgePolicy(env).limits.fileBytes) {
            throw new HttpError(413, "knowledge_file_too_large");
          }
        }
        return true;
      }
    });
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "invalid_zip_archive");
  }

  const normalized = Object.entries(entries)
    .map(([name, entryBytes]) => ({
      bytes: entryBytes,
      isDirectory: name.endsWith("/") || name.endsWith("\\"),
      originalPath: name,
      path: normalizeZipEntryPath(name)
    }))
    .filter((entry) => !ignoredZipEntry(entry.path || entry.originalPath));

  if (normalized.some((entry) => !entry.path)) {
    throw new HttpError(400, "invalid_zip_entry_path");
  }

  if (normalized.length === 0) {
    throw new HttpError(400, "empty_zip_archive");
  }
  if (normalized.length > effectiveKnowledgePolicy(env).limits.zipEntries) {
    throw new HttpError(413, "zip_too_many_entries");
  }
  const uncompressedBytes = normalized.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  if (uncompressedBytes > effectiveKnowledgePolicy(env).limits.zipUncompressedBytes) {
    throw new HttpError(413, "zip_uncompressed_size_too_large");
  }

  const archiveSha256 = await sha256Hex(bytes);
  const rootName = validateFolderName(archiveFolderName(zipFileName));
  const rootPath = joinPath(normalizePath(parentPath), rootName);
  const idempotencyKey = normalizeKnowledgeIdempotencyKey(mutation.idempotencyKey)
    ?? `zip:${archiveSha256}:${rootPath}`;
  const existingJob = await knowledgeZipImportJobByKey(env, namespace.id, idempotencyKey);
  if (existingJob) {
    assertMatchingKnowledgeZipImport(existingJob, archiveSha256, rootPath);
    if (existingJob.state === "committed") {
      return knowledgeZipImportResult(env, existingJob);
    }
    if (existingJob.state === "staging") {
      throw new HttpError(409, "knowledge_zip_import_in_progress");
    }
    await cleanupKnowledgeZipStagingPrefix(env, existingJob.staging_prefix);
  }

  const plan = await buildKnowledgeZipImportPlan(
    normalized,
    rootName,
    rootPath
  );
  await assertKnowledgeZipImportPreflight(env, namespace, rootPath, plan);
  const jobId = existingJob?.id ?? `kzip_${crypto.randomUUID()}`;
  const objectIds = plan.map((item) => item.id);
  const rootObject = plan[0];
  if (!rootObject || rootObject.kind !== "folder") {
    throw new HttpError(500, "knowledge_zip_plan_invalid");
  }
  // Retry prefixes are siblings of the legacy job prefix, never children that its sweeper can delete.
  const stagingPrefix = `${namespace.r2_prefix}/imports/${jobId}-${rootObject.id}`;
  plan.forEach((item) => {
    if (item.kind === "file" && item.versionId) {
      item.r2Key = `${stagingPrefix}/${item.versionId}`;
    }
  });
  const plannedTotalBytes = plan.reduce((sum, item) => sum + (item.bytes?.byteLength ?? 0), 0);
  const job = await beginKnowledgeZipImportJob(env, {
    archiveSha256,
    entryCount: normalized.length,
    id: jobId,
    idempotencyKey,
    namespaceId: namespace.id,
    objectIds,
    principal,
    rootObjectId: rootObject.id,
    rootPath,
    stagingPrefix,
    totalBytes: plannedTotalBytes
  });
  if (job.state === "committed") {
    return knowledgeZipImportResult(env, job);
  }
  if (job.state !== "staging" || job.root_object_id !== rootObject.id || job.staging_prefix !== stagingPrefix) {
    throw new HttpError(409, "knowledge_zip_import_in_progress");
  }

  const stagedKeys: string[] = [];
  try {
    for (const item of plan) {
      if (item.kind !== "file" || !item.bytes || !item.r2Key) {
        continue;
      }
      // Include ambiguous writes in compensation if storage accepts bytes but the response is lost.
      stagedKeys.push(item.r2Key);
      await env.KNOWLEDGE_OBJECTS.put(item.r2Key, item.bytes, {
        httpMetadata: { contentType: item.mimeType },
        customMetadata: {
          importJobId: job.id,
          namespaceId: namespace.id,
          objectId: item.id,
          sha256: item.sha256,
          versionId: item.versionId ?? ""
        }
      });
    }
  } catch {
    await failKnowledgeZipImportAndCleanup(env, job.id, stagingPrefix, stagedKeys, "knowledge_zip_staging_failed");
    throw new HttpError(502, "knowledge_zip_staging_failed");
  }

  // Preparation can read D1 (for the audit root) after staging. Compensate it too.
  try {
    const statements: D1PreparedStatement[] = [
      env.KNOWLEDGE_DB
        .prepare(
          `
          UPDATE knowledge_zip_import_jobs
          SET state = CASE
                WHEN state = 'staging' AND root_object_id = ? AND staging_prefix = ? THEN 'committed'
                ELSE NULL
              END,
              error_code = '',
              completed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `
        )
        // The existing NOT NULL constraint aborts the entire batch if staging ownership was lost.
        .bind(rootObject.id, stagingPrefix, job.id)
    ];
    for (const item of plan) {
      statements.push(
        env.KNOWLEDGE_DB
          .prepare(
            `
            INSERT INTO knowledge_objects (
              id,
              namespace_id,
              parent_path,
              path,
              file_name,
              object_kind,
              mime_type,
              content_kind,
              current_version_id,
              size_bytes,
              sha256,
              created_by_user_id,
              updated_by_user_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .bind(
            item.id,
            namespace.id,
            item.parentPath,
            item.path,
            item.fileName,
            item.kind,
            item.mimeType,
            item.contentKind,
            item.versionId ?? "",
            item.bytes?.byteLength ?? 0,
            item.sha256,
            principal.sub,
            principal.sub
          )
      );
      if (item.kind === "file" && item.versionId && item.r2Key) {
        const ingestion = builtInKnowledgeIngestionDecision(
          item.fileName,
          item.mimeType,
          item.bytes ?? new Uint8Array()
        );
        statements.push(
          env.KNOWLEDGE_DB
            .prepare(
              `
              INSERT INTO knowledge_object_versions (
                id,
                object_id,
                namespace_id,
                version,
                r2_key,
                mime_type,
                size_bytes,
                sha256,
                created_by_user_id
              )
              VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
              `
            )
            .bind(
              item.versionId,
              item.id,
              namespace.id,
              item.r2Key,
              item.mimeType,
              item.bytes?.byteLength ?? 0,
              item.sha256,
              principal.sub
            )
          ,
          env.KNOWLEDGE_DB
            .prepare(
              `INSERT INTO knowledge_ingestion_states (
                 object_id, version_id, scan_status, scanner_version, reason_code, scanned_at
               ) VALUES (
                 ?, ?, ?, 'builtin-policy-v1', ?,
                 CASE WHEN ? IN ('clean', 'blocked') THEN CURRENT_TIMESTAMP ELSE NULL END
               )`
            )
            .bind(
              item.id,
              item.versionId,
              ingestion.status,
              ingestion.reasonCode,
              ingestion.status
            )
        );
      }
    }
    if (!rootObject.parentPath) {
      const ownerPermissionId = `kperm_${crypto.randomUUID()}`;
      statements.push(
        env.KNOWLEDGE_DB
          .prepare(
            `INSERT INTO knowledge_permissions (
               id, namespace_id, object_id, subject_type, subject_id, role,
               can_share, can_publish_skill, granted_by_user_id, expires_at
             ) VALUES (?, ?, ?, 'user', ?, 'owner', 1, 0, ?, NULL)`
          )
          .bind(ownerPermissionId, namespace.id, rootObject.id, principal.sub, principal.sub),
        env.KNOWLEDGE_DB
          .prepare(
            `INSERT INTO knowledge_permission_provenance (
               permission_id, grant_source, source_id
             ) VALUES (?, 'direct', ?)`
          )
          .bind(ownerPermissionId, rootObject.id)
      );
    }
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `
          UPDATE knowledge_namespaces
          SET used_bytes = used_bytes + ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `
        )
        .bind(plannedTotalBytes, namespace.id)
    );
    if (knowledgeV2Flags(env).mutationSpine) {
      const rootForAudit = rootObject.parentPath
        ? await requireRootObjectForMutation(env, {
            id: rootObject.id,
            namespace_id: namespace.id,
            parent_path: rootObject.parentPath,
            path: rootObject.path,
            file_name: rootObject.fileName,
            object_kind: "folder",
            mime_type: rootObject.mimeType,
            content_kind: rootObject.contentKind,
            current_version_id: "",
            title: rootObject.fileName,
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
      const auditRootObjectId = rootForAudit?.id ?? rootObject.id;
      const commandId = `kmut_${crypto.randomUUID()}`;
      const changeSetId = `kchg_${crypto.randomUUID()}`;
      const firstChangeItemId = `kchi_${crypto.randomUUID()}`;
      const idempotencyScope = `${principal.orgId}:${principal.sub}:${auditRootObjectId}:zip_import`;
      const requestHash = await sha256Text(JSON.stringify({
        archiveSha256,
        entryCount: plan.length,
        operation: "zip_import",
        rootPath
      }));
      statements.push(
        mutationCommandGuardStatement(env, {
          commandId,
          expectedVersionId: "",
          idempotencyKey,
          idempotencyScope,
          namespaceId: namespace.id,
          objectId: rootObject.id,
          operation: "zip_import",
          orgId: principal.orgId,
          requestHash,
          rootObjectId: auditRootObjectId
        }),
        env.KNOWLEDGE_DB
          .prepare(
            `INSERT INTO knowledge_change_sets (
               id, org_id, namespace_id, root_object_id, mutation_command_id, request_id,
               idempotency_scope, idempotency_key, actor_type, actor_user_id, actor_email,
               source_channel, operation, summary, item_count
             )
             SELECT ?, ?, ?, ?, command.id, ?, command.idempotency_scope, command.idempotency_key,
                    'user', ?, ?, 'zip', 'zip_import', ?, ?
             FROM knowledge_mutation_commands AS command
             WHERE command.id = ? AND command.status = 'prepared'`
          )
          .bind(
            changeSetId,
            principal.orgId,
            namespace.id,
            auditRootObjectId,
            mutation.requestId,
            principal.sub,
            actorEmail,
            `zip_import ${rootPath}`,
            plan.length,
            commandId
          )
      );
      plan.forEach((item, index) => {
        const changeItemId = index === 0 ? firstChangeItemId : `kchi_${crypto.randomUUID()}`;
        statements.push(
          env.KNOWLEDGE_DB
            .prepare(
              `INSERT INTO knowledge_change_items (
                 id, change_set_id, root_object_id, object_id, action,
                 path_before, path_after, version_before_id, version_after_id,
                 sha256_before, sha256_after, size_before, size_after,
                 mime_type_before, mime_type_after, diff_status
               )
               SELECT ?, ?, ?, ?, 'zip_import', '', ?, '', ?, '', ?, 0, ?, '', ?, 'not_applicable'
               FROM knowledge_mutation_commands
               WHERE id = ? AND status = 'prepared'`
            )
            .bind(
              changeItemId,
              changeSetId,
              auditRootObjectId,
              item.id,
              item.path,
              item.versionId ?? "",
              item.sha256,
              item.bytes?.byteLength ?? 0,
              item.mimeType,
              commandId
            )
        );
      });
      const rootAuditObject: ObjectRow = {
        id: rootObject.id,
        namespace_id: namespace.id,
        parent_path: rootObject.parentPath,
        path: rootObject.path,
        file_name: rootObject.fileName,
        object_kind: "folder",
        mime_type: rootObject.mimeType,
        content_kind: rootObject.contentKind,
        current_version_id: "",
        title: rootObject.fileName,
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
      statements.push(
        ...indexOutboxStatements(
          env,
          rootAuditObject,
          changeSetId,
          "",
          "backfill",
          `kidx_${crypto.randomUUID()}`,
          commandId
        ),
        commitMetadataMutationStatement(env, commandId, firstChangeItemId, {
          changeSetId,
          importJobId: job.id,
          objectId: rootObject.id,
          path: rootPath
        })
      );
    }

    await env.KNOWLEDGE_DB.batch(statements);
  } catch (error) {
    let committedJob: KnowledgeZipImportJobRow | null;
    try {
      committedJob = await knowledgeZipImportJobById(env, job.id);
    } catch (lookupError) {
      console.error("knowledge_zip_import_commit_state_unknown", {
        batchErrorName: safeErrorName(error),
        jobId: job.id,
        lookupErrorName: safeErrorName(lookupError)
      });
      throw error;
    }
    if (committedJob?.state === "committed" && committedJob.staging_prefix === stagingPrefix) {
      return knowledgeZipImportResult(env, committedJob);
    }
    const lostOwnership = committedJob?.state !== "staging" || committedJob.staging_prefix !== stagingPrefix;
    const errorCode = lostOwnership
      ? "knowledge_zip_publish_failed"
      : error instanceof HttpError
        ? error.code
        : /knowledge_namespace_quota_exceeded/i.test(safeErrorMessage(error))
          ? "knowledge_namespace_quota_exceeded"
          : /unique|constraint/i.test(safeErrorMessage(error))
            ? "knowledge_zip_path_conflict"
            : "knowledge_zip_publish_failed";
    await failKnowledgeZipImportAndCleanup(env, job.id, stagingPrefix, stagedKeys, errorCode);
    throw new HttpError(error instanceof HttpError ? error.status : errorCode === "knowledge_namespace_quota_exceeded" ? 413 : 409, errorCode);
  }

  if (knowledgeV2Flags(env).mutationSpine) {
    await dispatchKnowledgeIndexOutboxAfterMutation(env);
  } else {
    try {
      await markKnowledgeServicesStaleForPath(env, namespace.id, rootPath);
    } catch (error) {
      console.error("knowledge_zip_import_stale_mark_failed", {
        errorName: safeErrorName(error),
        jobId: job.id
      });
    }
  }
  const committedJob = await knowledgeZipImportJobById(env, job.id);
  if (!committedJob || committedJob.state !== "committed") {
    throw new HttpError(500, "knowledge_zip_import_commit_missing");
  }
  return knowledgeZipImportResult(env, committedJob);
}
