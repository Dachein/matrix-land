import { safeErrorName } from "../../errors.ts";
import { knowledgeZipImportJobById } from "./jobs.ts";
import type { Env, KnowledgeZipImportJobRow } from "../../types.ts";

export async function failKnowledgeZipImportAndCleanup(
  env: Env,
  jobId: string,
  stagingPrefix: string,
  stagedKeys: string[],
  errorCode: string
) {
  const failed = await env.KNOWLEDGE_DB
    .prepare(
      `UPDATE knowledge_zip_import_jobs
       SET state = 'failed', error_code = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND staging_prefix = ? AND state != 'committed'`
    )
    .bind(errorCode, jobId, stagingPrefix)
    .run();
  if (!failed.meta.changes) {
    const current = await knowledgeZipImportJobById(env, jobId);
    if (current?.state === "committed" && current.staging_prefix === stagingPrefix) return;
  }
  for (const key of stagedKeys) {
    try {
      await env.KNOWLEDGE_OBJECTS.delete(key);
    } catch (error) {
      console.error("knowledge_zip_staging_cleanup_failed", {
        errorName: safeErrorName(error),
        jobId
      });
    }
  }
  if (stagedKeys.length === 0) {
    await cleanupKnowledgeZipStagingPrefix(env, stagingPrefix);
  }
}

export async function cleanupKnowledgeZipStagingPrefix(env: Env, prefix: string) {
  if (!("list" in env.KNOWLEDGE_OBJECTS)) {
    return;
  }
  let cursor: string | undefined;
  do {
    const listed = await env.KNOWLEDGE_OBJECTS.list({
      prefix: `${prefix}/`,
      ...(cursor ? { cursor } : {})
    });
    for (const object of listed.objects) {
      await env.KNOWLEDGE_OBJECTS.delete(object.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

export async function cleanupStaleKnowledgeZipImports(env: Env) {
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT *
      FROM knowledge_zip_import_jobs
      WHERE state IN ('staging', 'failed')
        AND updated_at < datetime('now', '-1 hour')
      ORDER BY updated_at
      LIMIT 50
      `
    )
    .all<KnowledgeZipImportJobRow>();
  for (const job of rows.results ?? []) {
    try {
      // Claim the exact stale attempt before removing storage; publication may have won since SELECT.
      const expired = await env.KNOWLEDGE_DB
        .prepare(
          `
          UPDATE knowledge_zip_import_jobs
          SET state = 'failed',
              error_code = CASE WHEN error_code = '' THEN 'knowledge_zip_import_expired' ELSE error_code END,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND staging_prefix = ?
            AND state IN ('staging', 'failed')
            AND updated_at < datetime('now', '-1 hour')
          `
        )
        .bind(job.id, job.staging_prefix)
        .run();
      if (!expired.meta.changes) continue;
      await cleanupKnowledgeZipStagingPrefix(env, job.staging_prefix);
    } catch (error) {
      console.error("knowledge_zip_import_sweeper_failed", {
        errorName: safeErrorName(error),
        jobId: job.id
      });
    }
  }
}
