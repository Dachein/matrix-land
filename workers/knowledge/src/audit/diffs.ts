import { safeErrorMessage, safeErrorName } from "../errors.ts";
import { sha256Hex } from "../objects/content.ts";
import type { Env } from "../types.ts";
import { readString } from "../values.ts";

export async function processKnowledgeDiffOutbox(env: Env, limit: number, versionAfterId = "") {
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT outbox.id AS outbox_id, outbox.attempt_count, item.*,
              before_version.r2_key AS before_r2_key,
              after_version.r2_key AS after_r2_key
       FROM knowledge_diff_outbox AS outbox
       JOIN knowledge_change_items AS item ON item.id = outbox.change_item_id
       LEFT JOIN knowledge_object_versions AS before_version ON before_version.id = item.version_before_id
       LEFT JOIN knowledge_object_versions AS after_version ON after_version.id = item.version_after_id
       WHERE outbox.status IN ('pending', 'failed')
         AND (outbox.next_attempt_at IS NULL OR datetime(outbox.next_attempt_at) <= CURRENT_TIMESTAMP)
         AND (? = '' OR item.version_after_id = ?)
       ORDER BY outbox.created_at
       LIMIT ?`
    )
    .bind(versionAfterId, versionAfterId, Math.max(1, Math.min(100, limit)))
    .all<Record<string, unknown>>();
  for (const row of rows.results ?? []) {
    const outboxId = readString(row.outbox_id);
    const changeItemId = readString(row.id);
    try {
      await env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_diff_outbox
           SET status = 'dispatching', attempt_count = attempt_count + 1,
               last_error = '', updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status IN ('pending', 'failed')`
        )
        .bind(outboxId)
        .run();
      const beforeObject = await env.KNOWLEDGE_OBJECTS.get(readString(row.before_r2_key));
      const afterObject = await env.KNOWLEDGE_OBJECTS.get(readString(row.after_r2_key));
      if (!beforeObject || !afterObject) {
        throw new Error("knowledge_diff_source_missing");
      }
      const beforeText = new TextDecoder().decode(await beforeObject.arrayBuffer());
      const afterText = new TextDecoder().decode(await afterObject.arrayBuffer());
      const originalDiff = createUnifiedKnowledgeDiff(
        beforeText,
        afterText,
        readString(row.path_before),
        readString(row.path_after)
      );
      const originalBytes = new TextEncoder().encode(originalDiff);
      const maxDiffBytes = 2_000_000;
      const diffBytes = originalBytes.byteLength > maxDiffBytes
        ? originalBytes.slice(0, maxDiffBytes)
        : originalBytes;
      const diffSha256 = await sha256Hex(diffBytes);
      const diffR2Key = `audit/diffs/${changeItemId}/${diffSha256}.diff`;
      await env.KNOWLEDGE_OBJECTS.put(diffR2Key, diffBytes, {
        httpMetadata: { contentType: "text/x-diff; charset=utf-8" },
        customMetadata: { changeItemId, diffSha256 }
      });
      const diffText = new TextDecoder().decode(diffBytes);
      await env.KNOWLEDGE_DB.batch([
        env.KNOWLEDGE_DB
          .prepare(
            `UPDATE knowledge_change_items
             SET diff_status = 'ready', diff_r2_key = ?, diff_sha256 = ?,
                 diff_size_bytes = ?, diff_original_size_bytes = ?,
                 diff_line_count = ?, diff_generator_version = 'builtin-unified-v1',
                 error_code = ''
             WHERE id = ?`
          )
          .bind(
            diffR2Key,
            diffSha256,
            diffBytes.byteLength,
            originalBytes.byteLength,
            diffText.split(/\r?\n/).length,
            changeItemId
          ),
        env.KNOWLEDGE_DB
          .prepare(
            `UPDATE knowledge_diff_outbox
             SET status = 'completed', last_error = '', completed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
          .bind(outboxId)
      ]);
    } catch (error) {
      const attemptCount = Number(row.attempt_count ?? 0) + 1;
      await env.KNOWLEDGE_DB.batch([
        env.KNOWLEDGE_DB
          .prepare(
            `UPDATE knowledge_change_items
             SET diff_status = CASE WHEN ? >= 5 THEN 'failed' ELSE 'pending' END,
                 error_code = ?
             WHERE id = ?`
          )
          .bind(attemptCount, safeErrorName(error), changeItemId),
        env.KNOWLEDGE_DB
          .prepare(
            `UPDATE knowledge_diff_outbox
             SET status = CASE WHEN ? >= 5 THEN 'failed' ELSE 'pending' END,
                 next_attempt_at = datetime(CURRENT_TIMESTAMP, '+' || MIN(3600, ? * 30) || ' seconds'),
                 last_error = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
          .bind(
            attemptCount,
            attemptCount,
            safeErrorMessage(error).slice(0, 500) || safeErrorName(error),
            outboxId
          )
      ]);
    }
  }
}

export async function processKnowledgeDiffOutboxAfterMutation(env: Env, versionAfterId: string) {
  await processKnowledgeDiffOutbox(env, 1, versionAfterId);
  // Heal one older failed/pending Diff opportunistically so a transient
  // deployment or queue gap does not have to wait for the hourly reconciler.
  await processKnowledgeDiffOutbox(env, 1);
}

function createUnifiedKnowledgeDiff(before: string, after: string, pathBefore: string, pathAfter: string) {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let prefix = 0;
  while (
    prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const contextStart = Math.max(0, prefix - 3);
  const beforeEnd = Math.min(beforeLines.length, beforeLines.length - suffix + 3);
  const afterEnd = Math.min(afterLines.length, afterLines.length - suffix + 3);
  const removedStart = prefix;
  const removedEnd = beforeLines.length - suffix;
  const addedEnd = afterLines.length - suffix;
  const lines = [
    `--- a/${pathBefore || pathAfter}`,
    `+++ b/${pathAfter || pathBefore}`,
    `@@ -${contextStart + 1},${beforeEnd - contextStart} +${contextStart + 1},${afterEnd - contextStart} @@`
  ];
  for (let index = contextStart; index < prefix; index += 1) {
    lines.push(` ${beforeLines[index] ?? ""}`);
  }
  for (let index = removedStart; index < removedEnd; index += 1) {
    lines.push(`-${beforeLines[index] ?? ""}`);
  }
  for (let index = removedStart; index < addedEnd; index += 1) {
    lines.push(`+${afterLines[index] ?? ""}`);
  }
  for (let index = Math.max(prefix, beforeLines.length - suffix); index < beforeEnd; index += 1) {
    lines.push(` ${beforeLines[index] ?? ""}`);
  }
  return `${lines.join("\n")}\n`;
}
