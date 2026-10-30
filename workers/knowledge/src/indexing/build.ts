import { HttpError } from "../http.ts";
import { requireVersion } from "../objects/repository.ts";
import { effectiveKnowledgePolicy } from "../policy.ts";
import { isTextualSnapshot } from "../services/snapshots.ts";
import type { Env, KnowledgeServiceRow, KnowledgeServiceSnapshot } from "../types.ts";

// Build canonical documents and chunks, respecting ingestion decisions and handbook boundaries.
export async function replaceCanonicalKnowledgeIndex(
  env: Env,
  service: KnowledgeServiceRow,
  snapshots: KnowledgeServiceSnapshot[]
) {
  const statements: D1PreparedStatement[] = [
    env.KNOWLEDGE_DB
      .prepare("DELETE FROM knowledge_index_documents WHERE service_id = ?")
      .bind(service.id)
  ];
  let readyCount = 0;
  let skippedCount = 0;
  let pendingCount = 0;
  let blockedCount = 0;
  for (const snapshot of snapshots) {
    const documentId = `kdoc_${crypto.randomUUID()}`;
    const ingestion = await env.KNOWLEDGE_DB
      .prepare(
        `SELECT scan_status, reason_code
         FROM knowledge_ingestion_states
         WHERE object_id = ? AND version_id = ?`
      )
      .bind(snapshot.objectId, snapshot.versionId)
      .first<{ reason_code: string; scan_status: "blocked" | "clean" | "error" | "pending" }>();
    if (ingestion?.scan_status !== "clean") {
      const blocked = ingestion?.scan_status === "blocked" || ingestion?.scan_status === "error";
      blockedCount += blocked ? 1 : 0;
      pendingCount += blocked ? 0 : 1;
      statements.push(
        env.KNOWLEDGE_DB
          .prepare(
            `INSERT INTO knowledge_index_documents (
               id, service_id, root_object_id, object_id, version_id, mime_type,
               extractor_version, status, reason_code, content_hash, chunk_count
             ) VALUES (?, ?, ?, ?, ?, ?, 'builtin-v1', ?, ?, ?, 0)`
          )
          .bind(
            documentId,
            service.id,
            service.folder_object_id,
            snapshot.objectId,
            snapshot.versionId,
            snapshot.mimeType,
            blocked ? "blocked" : "pending",
            ingestion?.reason_code || "scan_pending",
            snapshot.sha256
          )
      );
      continue;
    }
    const textual = isTextualSnapshot(snapshot);
    const skipped = snapshot.isHandbook || !textual || snapshot.sizeBytes > effectiveKnowledgePolicy(env).limits.textIndexBytes;
    if (skipped) {
      skippedCount += 1;
      statements.push(
        env.KNOWLEDGE_DB
          .prepare(
            `INSERT INTO knowledge_index_documents (
               id, service_id, root_object_id, object_id, version_id, mime_type,
               extractor_version, status, reason_code, content_hash, chunk_count, indexed_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'builtin-v1', 'skipped', ?, ?, 0, CURRENT_TIMESTAMP)`
          )
          .bind(
            documentId,
            service.id,
            service.folder_object_id,
            snapshot.objectId,
            snapshot.versionId,
            snapshot.mimeType,
            snapshot.isHandbook
              ? "handbook_instruction_boundary"
              : snapshot.sizeBytes > effectiveKnowledgePolicy(env).limits.textIndexBytes
                ? "text_size_limit"
                : "unsupported_mime",
            snapshot.sha256
          )
      );
      continue;
    }
    const version = await requireVersion(env, snapshot.versionId);
    const r2Object = await env.KNOWLEDGE_OBJECTS.get(version.r2_key);
    if (!r2Object) {
      throw new HttpError(409, "knowledge_index_source_missing");
    }
    const source = new TextDecoder().decode(await r2Object.arrayBuffer());
    const chunks = chunkKnowledgeText(source);
    readyCount += 1;
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_index_documents (
             id, service_id, root_object_id, object_id, version_id, mime_type,
             extractor_version, status, content_hash, chunk_count, indexed_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'builtin-v1', 'ready', ?, ?, CURRENT_TIMESTAMP)`
        )
        .bind(
          documentId,
          service.id,
          service.folder_object_id,
          snapshot.objectId,
          snapshot.versionId,
          snapshot.mimeType,
          snapshot.sha256,
          chunks.length
        )
    );
    chunks.forEach((chunk, index) => {
      statements.push(
        env.KNOWLEDGE_DB
          .prepare(
            `INSERT INTO knowledge_index_chunks (
               chunk_id, document_id, service_id, object_id, version_id, chunk_ordinal,
               relative_path_cache, start_line, end_line, text, content_hash
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            `kchunk_${crypto.randomUUID()}`,
            documentId,
            service.id,
            snapshot.objectId,
            snapshot.versionId,
            index,
            snapshot.relativePath,
            chunk.startLine,
            chunk.endLine,
            chunk.text,
            snapshot.sha256
          )
      );
    });
  }
  statements.push(
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_service_index_state (
           service_id, source_revision, indexed_revision, index_generation, status,
           pending_object_count, skipped_object_count, blocked_object_count,
           last_error, indexed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(service_id) DO UPDATE SET
           source_revision = excluded.source_revision,
           indexed_revision = excluded.indexed_revision,
           index_generation = excluded.index_generation,
           status = excluded.status,
           pending_object_count = excluded.pending_object_count,
           skipped_object_count = excluded.skipped_object_count,
           blocked_object_count = excluded.blocked_object_count,
           last_error = '',
           indexed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(
        service.id,
        service.source_revision,
        service.source_revision,
        service.index_generation + 1,
        pendingCount || blockedCount ? "partial" : "ready",
        pendingCount,
        skippedCount,
        blockedCount
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_index_outbox
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE service_id = ? AND status IN ('pending', 'dispatching', 'dispatched')
           AND source_revision <= ?`
      )
      .bind(service.id, service.source_revision)
  );
  await env.KNOWLEDGE_DB.batch(statements);
  console.log("knowledge_index_rebuilt", {
    readyCount,
    blockedCount,
    pendingCount,
    serviceId: service.id,
    skippedCount,
    sourceRevision: service.source_revision
  });
}

function chunkKnowledgeText(source: string) {
  const lines = source.split(/\r?\n/);
  const chunks: Array<{ endLine: number; startLine: number; text: string }> = [];
  let startIndex = 0;
  while (startIndex < lines.length) {
    let endIndex = Math.min(lines.length, startIndex + 40);
    while (endIndex > startIndex + 1 && lines.slice(startIndex, endIndex).join("\n").length > 8_000) {
      endIndex -= 1;
    }
    const text = lines.slice(startIndex, endIndex).join("\n");
    if (text.trim()) {
      chunks.push({ endLine: endIndex, startLine: startIndex + 1, text });
    }
    startIndex = Math.max(endIndex, startIndex + 1);
  }
  return chunks;
}
