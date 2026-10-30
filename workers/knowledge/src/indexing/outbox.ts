import { safeErrorMessage, safeErrorName } from "../errors.ts";
import type { Env } from "../types.ts";

// Dispatch and acknowledge committed index invalidations, with retry state held in D1.
export async function dispatchKnowledgeIndexOutbox(env: Env) {
  // A terminated sender cannot transition its claim to dispatched or failed.
  // Reclaim only abandoned sends; queue consumption remains separate,
  // and current sends and failed-message backoff retain their existing state.
  await env.KNOWLEDGE_DB
    .prepare(
      `UPDATE knowledge_index_outbox
       SET status = 'failed', next_attempt_at = CURRENT_TIMESTAMP,
           last_error = 'index_dispatch_interrupted', updated_at = CURRENT_TIMESTAMP
       WHERE status = 'dispatching'
         AND datetime(updated_at) <= datetime(CURRENT_TIMESTAMP, '-5 minutes')`
    )
    .run();

  const pending = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT service_id, MAX(source_revision) AS source_revision
       FROM knowledge_index_outbox
       WHERE status IN ('pending', 'failed')
         AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= CURRENT_TIMESTAMP)
       GROUP BY service_id
       ORDER BY MIN(created_at)
       LIMIT 25`
    )
    .all<{ service_id: string; source_revision: number }>();
  for (const row of pending.results ?? []) {
    if (!env.KNOWLEDGE_INDEX_QUEUE) {
      console.warn("knowledge_index_queue_unbound", { serviceId: row.service_id });
      continue;
    }
    await env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_index_outbox
         SET status = 'dispatching', attempt_count = attempt_count + 1,
             last_error = '', updated_at = CURRENT_TIMESTAMP
         WHERE service_id = ? AND source_revision <= ?
           AND status IN ('pending', 'failed')`
      )
      .bind(row.service_id, row.source_revision)
      .run();
    try {
      await env.KNOWLEDGE_INDEX_QUEUE.send({
        kind: "service_reindex",
        serviceId: row.service_id,
        sourceRevision: Number(row.source_revision)
      });
      await env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_index_outbox
           SET status = 'dispatched', updated_at = CURRENT_TIMESTAMP
           WHERE service_id = ? AND source_revision <= ? AND status = 'dispatching'`
        )
        .bind(row.service_id, row.source_revision)
        .run();
    } catch (error) {
      await failKnowledgeIndexOutbox(env, row.service_id, error);
    }
  }
}

export async function dispatchKnowledgeIndexOutboxAfterMutation(env: Env) {
  if (!env.KNOWLEDGE_INDEX_QUEUE) {
    return;
  }
  try {
    await dispatchKnowledgeIndexOutbox(env);
  } catch (error) {
    console.error("knowledge_index_dispatch_after_mutation_failed", {
      errorName: safeErrorName(error),
      message: safeErrorMessage(error).slice(0, 500)
    });
  }
}

export async function completeKnowledgeIndexOutbox(env: Env, serviceId: string, sourceRevision: number) {
  await env.KNOWLEDGE_DB
    .prepare(
      `UPDATE knowledge_index_outbox
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
           last_error = '', updated_at = CURRENT_TIMESTAMP
       WHERE service_id = ? AND source_revision <= ?
         AND status IN ('pending', 'dispatching', 'dispatched', 'failed')`
    )
    .bind(serviceId, sourceRevision)
    .run();
}

export async function failKnowledgeIndexOutbox(env: Env, serviceId: string, error: unknown) {
  await env.KNOWLEDGE_DB
    .prepare(
      `UPDATE knowledge_index_outbox
       SET status = 'failed',
           next_attempt_at = datetime(CURRENT_TIMESTAMP, '+' || MIN(3600, MAX(30, attempt_count * 30)) || ' seconds'),
           last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE service_id = ? AND status IN ('dispatching', 'dispatched')`
    )
    .bind(safeErrorMessage(error).slice(0, 500) || safeErrorName(error), serviceId)
    .run();
}
