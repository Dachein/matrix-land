import { HttpError } from "../http.ts";
import { knowledgeServiceJson, knowledgeServiceVersionJson } from "../services/representation.ts";
import type { Env, Principal } from "../types.ts";
import { readBoolean, readString } from "../values.ts";
import { canonicalIndexContext, canonicalIndexStatus } from "./context.ts";
import { bestSnippet, readLimit, searchTerms, stripMarkup } from "./text.ts";

// Search only current, undeleted and ingestion-approved canonical document versions.
export async function knowledgeServiceSearchV2(
  env: Env,
  principal: Principal,
  serviceId: string,
  body: Record<string, unknown>
) {
  const context = await canonicalIndexContext(env, principal, serviceId);
  const query = readString(body.query ?? body.q).trim();
  if (!query) {
    throw new HttpError(400, "missing_knowledge_service_search_query");
  }
  if (query.length > 500) {
    throw new HttpError(400, "knowledge_service_search_query_too_long");
  }
  const limit = readLimit(body.limit, 10, 50);
  const matchQuery = `"${query.replace(/"/g, '""')}"`;
  let rows: D1Result<{
    chunk_text: string;
    content_kind: string;
    file_name: string;
    mime_type: string;
    object_id: string;
    path: string;
    relative_path: string;
    score: number;
    start_line: number;
    version_id: string;
  }>;
  try {
    rows = await env.KNOWLEDGE_DB
      .prepare(
        `SELECT chunk.object_id, chunk.version_id, object.path, object.file_name,
                object.content_kind, document.mime_type, chunk.relative_path_cache AS relative_path,
                chunk.start_line, chunk.text AS chunk_text, -bm25(knowledge_index_fts) AS score
         FROM knowledge_index_fts
         JOIN knowledge_index_chunks AS chunk ON chunk.id = knowledge_index_fts.rowid
         JOIN knowledge_index_documents AS document ON document.id = chunk.document_id
         JOIN knowledge_objects AS object ON object.id = chunk.object_id
         WHERE knowledge_index_fts MATCH ?
           AND chunk.service_id = ?
           AND document.status = 'ready'
           AND document.version_id = object.current_version_id
           AND chunk.version_id = object.current_version_id
           AND object.deleted_at IS NULL
         ORDER BY bm25(knowledge_index_fts), chunk.id
         LIMIT ?`
      )
      .bind(matchQuery, context.service.id, limit)
      .all();
  } catch {
    throw new HttpError(400, "invalid_knowledge_service_search_query");
  }
  return {
    index: canonicalIndexStatus(context),
    query,
    results: (rows.results ?? []).map((row) => ({
      contentKind: row.content_kind,
      fileName: row.file_name,
      lineNumber: row.start_line,
      mimeType: row.mime_type,
      objectId: row.object_id,
      path: row.path,
      relativePath: row.relative_path,
      score: Number(row.score),
      snippet: bestSnippet(stripMarkup(row.chunk_text), searchTerms(query)),
      versionId: row.version_id
    })),
    service: knowledgeServiceJson(context.service, context.version, context.effectiveRole),
    version: knowledgeServiceVersionJson(context.version)
  };
}

export async function knowledgeServiceGrepV2(
  env: Env,
  principal: Principal,
  serviceId: string,
  body: Record<string, unknown>
) {
  const context = await canonicalIndexContext(env, principal, serviceId);
  const pattern = readString(body.pattern ?? body.query ?? body.q).trim();
  if (!pattern) {
    throw new HttpError(400, "missing_knowledge_service_grep_pattern");
  }
  if (pattern.length > 500) {
    throw new HttpError(400, "knowledge_service_grep_pattern_too_long");
  }
  if (readBoolean(body.regex)) {
    throw new HttpError(400, "knowledge_service_regex_not_enabled");
  }
  const caseSensitive = readBoolean(body.caseSensitive ?? body.case_sensitive);
  const limit = readLimit(body.limit, 20, 100);
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT chunk.object_id, chunk.version_id, object.path, object.file_name,
              object.content_kind, document.mime_type, chunk.relative_path_cache AS relative_path,
              chunk.start_line, chunk.text AS chunk_text
       FROM knowledge_index_chunks AS chunk
       JOIN knowledge_index_documents AS document ON document.id = chunk.document_id
       JOIN knowledge_objects AS object ON object.id = chunk.object_id
       WHERE chunk.service_id = ?
         AND document.status = 'ready'
         AND document.version_id = object.current_version_id
         AND chunk.version_id = object.current_version_id
         AND object.deleted_at IS NULL
         AND instr(
           CASE WHEN ? = 1 THEN chunk.text ELSE lower(chunk.text) END,
           CASE WHEN ? = 1 THEN ? ELSE lower(?) END
         ) > 0
       ORDER BY chunk.relative_path_cache, chunk.chunk_ordinal
       LIMIT ?`
    )
    .bind(context.service.id, caseSensitive ? 1 : 0, caseSensitive ? 1 : 0, pattern, pattern, Math.min(500, limit * 10))
    .all<{
      chunk_text: string;
      content_kind: string;
      file_name: string;
      mime_type: string;
      object_id: string;
      path: string;
      relative_path: string;
      start_line: number;
      version_id: string;
    }>();
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const results: Array<Record<string, unknown>> = [];
  for (const row of rows.results ?? []) {
    const lines = row.chunk_text.split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < limit; index += 1) {
      const line = lines[index] ?? "";
      const candidate = caseSensitive ? line : line.toLowerCase();
      if (!candidate.includes(needle)) {
        continue;
      }
      results.push({
        contentKind: row.content_kind,
        fileName: row.file_name,
        line: line.slice(0, 800),
        lineNumber: row.start_line + index,
        mimeType: row.mime_type,
        objectId: row.object_id,
        path: row.path,
        relativePath: row.relative_path,
        versionId: row.version_id
      });
    }
    if (results.length >= limit) {
      break;
    }
  }
  return {
    caseSensitive,
    index: canonicalIndexStatus(context),
    pattern,
    results,
    service: knowledgeServiceJson(context.service, context.version, context.effectiveRole),
    version: knowledgeServiceVersionJson(context.version)
  };
}
