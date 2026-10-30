import { HttpError } from "../../http.ts";
import { requireObject } from "../../objects/repository.ts";
import type { Env, KnowledgeZipImportJobRow, NamespaceRow, PlannedZipObject, Principal } from "../../types.ts";
import { safeJsonStringArray } from "../../values.ts";

export async function assertKnowledgeZipImportPreflight(
  env: Env,
  namespace: NamespaceRow,
  rootPath: string,
  plan: PlannedZipObject[]
) {
  const existing = await env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM knowledge_objects
      WHERE namespace_id = ?
        AND deleted_at IS NULL
        AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
      `
    )
    // D1 limits LIKE patterns to 50 UTF-8 bytes; paths are literal and may be longer.
    .bind(namespace.id, rootPath, rootPath, rootPath)
    .first<{ count: number }>();
  if (Number(existing?.count ?? 0) > 0) {
    throw new HttpError(409, "knowledge_zip_root_exists");
  }
  const current = await env.KNOWLEDGE_DB
    .prepare("SELECT quota_bytes AS quotaBytes, used_bytes AS usedBytes FROM knowledge_namespaces WHERE id = ?")
    .bind(namespace.id)
    .first<{ quotaBytes: number; usedBytes: number }>();
  const totalBytes = plan.reduce((sum, item) => sum + (item.bytes?.byteLength ?? 0), 0);
  if (current && current.quotaBytes > 0 && current.usedBytes + totalBytes > current.quotaBytes) {
    throw new HttpError(413, "knowledge_namespace_quota_exceeded");
  }
}

export async function beginKnowledgeZipImportJob(
  env: Env,
  input: {
    archiveSha256: string;
    entryCount: number;
    id: string;
    idempotencyKey: string;
    namespaceId: string;
    objectIds: string[];
    principal: Principal;
    rootObjectId: string;
    rootPath: string;
    stagingPrefix: string;
    totalBytes: number;
  }
) {
  await env.KNOWLEDGE_DB
    .prepare(
      `
      INSERT OR IGNORE INTO knowledge_zip_import_jobs (
        id,
        namespace_id,
        idempotency_key,
        archive_sha256,
        root_path,
        root_object_id,
        object_ids_json,
        staging_prefix,
        total_bytes,
        entry_count,
        state,
        created_by_user_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?)
      `
    )
    .bind(
      input.id,
      input.namespaceId,
      input.idempotencyKey,
      input.archiveSha256,
      input.rootPath,
      input.rootObjectId,
      JSON.stringify(input.objectIds),
      input.stagingPrefix,
      input.totalBytes,
      input.entryCount,
      input.principal.sub
    )
    .run();
  const current = await knowledgeZipImportJobByKey(env, input.namespaceId, input.idempotencyKey);
  if (!current) {
    throw new HttpError(500, "knowledge_zip_import_job_missing");
  }
  assertMatchingKnowledgeZipImport(current, input.archiveSha256, input.rootPath);
  if (current.state === "failed") {
    await env.KNOWLEDGE_DB
      .prepare(
        `
        UPDATE knowledge_zip_import_jobs
        SET root_object_id = ?,
            object_ids_json = ?,
            staging_prefix = ?,
            total_bytes = ?,
            entry_count = ?,
            state = 'staging',
            error_code = '',
            completed_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'failed'
        `
      )
      .bind(
        input.rootObjectId,
        JSON.stringify(input.objectIds),
        input.stagingPrefix,
        input.totalBytes,
        input.entryCount,
        current.id
      )
      .run();
    return await knowledgeZipImportJobById(env, current.id) ?? current;
  }
  return current;
}

export async function knowledgeZipImportJobByKey(env: Env, namespaceId: string, idempotencyKey: string) {
  return env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT *
      FROM knowledge_zip_import_jobs
      WHERE namespace_id = ? AND idempotency_key = ?
      LIMIT 1
      `
    )
    .bind(namespaceId, idempotencyKey)
    .first<KnowledgeZipImportJobRow>();
}

export async function knowledgeZipImportJobById(env: Env, jobId: string) {
  return env.KNOWLEDGE_DB
    .prepare("SELECT * FROM knowledge_zip_import_jobs WHERE id = ? LIMIT 1")
    .bind(jobId)
    .first<KnowledgeZipImportJobRow>();
}

export function assertMatchingKnowledgeZipImport(
  job: KnowledgeZipImportJobRow,
  archiveSha256: string,
  rootPath: string
) {
  if (job.archive_sha256 !== archiveSha256 || job.root_path !== rootPath) {
    throw new HttpError(409, "knowledge_zip_idempotency_conflict");
  }
}

export async function knowledgeZipImportResult(env: Env, job: KnowledgeZipImportJobRow) {
  const objectIds = safeJsonStringArray(job.object_ids_json);
  const objects = await Promise.all(objectIds.map((id) => requireObject(env, id)));
  const root = objects.find((object) => object.id === job.root_object_id);
  if (!root) {
    throw new HttpError(500, "knowledge_zip_import_root_missing");
  }
  return {
    importJobId: job.id,
    object: root,
    objects
  };
}
