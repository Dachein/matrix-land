import type { Env, Principal, ObjectRow, KnowledgeServiceSnapshot } from "../types.ts";
import { requireReadableObject } from "../objects/access.ts";
import { HttpError } from "../http.ts";
import { readString, readBoolean } from "../values.ts";
import { readLimit, searchTerms, stripMarkup, scoreSearchText, bestSnippet } from "./text.ts";
import { objectJsonListForPrincipal } from "../objects/representation.ts";
import { relativeKnowledgePath } from "../paths.ts";
import { isTextualSnapshot, readSnapshotText } from "../services/snapshots.ts";
import { KNOWLEDGE_ACTION_MAX_TEXT_BYTES } from "../policy.ts";

export async function knowledgeFolderTextQuery(
  env: Env,
  principal: Principal,
  folderObjectId: string,
  action: "search" | "grep",
  body: Record<string, unknown>
) {
  const folder = await requireReadableObject(env, principal, folderObjectId);
  if (folder.object_kind !== "folder") throw new HttpError(400, "knowledge_query_target_not_folder");
  const query = readString(action === "search" ? body.query ?? body.q : body.pattern ?? body.query ?? body.q).trim();
  if (!query) throw new HttpError(400, action === "search" ? "missing_knowledge_search_query" : "missing_knowledge_grep_pattern");
  if (query.length > 500) throw new HttpError(400, "knowledge_text_query_too_long");
  const limit = readLimit(body.limit, action === "search" ? 10 : 20, action === "search" ? 50 : 100);
  const caseSensitive = readBoolean(body.caseSensitive ?? body.case_sensitive);
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT object.* FROM knowledge_objects AS object
       WHERE object.namespace_id = ? AND object.object_kind = 'file'
         AND object.deleted_at IS NULL
         AND (object.parent_path = ? OR substr(object.parent_path, 1, length(?) + 1) = ? || '/')
       ORDER BY lower(object.path), object.id
       LIMIT 501`
    )
    .bind(folder.namespace_id, folder.path, folder.path, folder.path)
    .all<ObjectRow>();
  const files = rows.results ?? [];
  if (files.length > 500) throw new HttpError(413, "knowledge_folder_text_search_too_large");
  const projected = await objectJsonListForPrincipal(env, files, principal);
  const readableIds = new Set(projected.filter((item) => item.capabilities.canRead).map((item) => item.id));
  const snapshots: KnowledgeServiceSnapshot[] = files
    .filter((file) => readableIds.has(file.id) && Boolean(file.current_version_id))
    .map((file) => ({
      objectId: file.id,
      versionId: file.current_version_id!,
      path: file.path,
      relativePath: relativeKnowledgePath(folder.path, file.path),
      fileName: file.file_name,
      contentKind: file.content_kind,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      sha256: file.sha256,
      isHandbook: false
    }));
  const textBytes = snapshots
    .filter((snapshot) => isTextualSnapshot(snapshot) && snapshot.sizeBytes <= KNOWLEDGE_ACTION_MAX_TEXT_BYTES)
    .reduce((total, snapshot) => total + snapshot.sizeBytes, 0);
  if (textBytes > 20_000_000) throw new HttpError(413, "knowledge_folder_text_search_too_large");

  const results: Array<Record<string, unknown>> = [];
  const terms = action === "search" ? searchTerms(query) : [];
  const needle = caseSensitive ? query : query.toLowerCase();
  let scannedFiles = 0;
  let skippedFiles = 0;
  for (let offset = 0; offset < snapshots.length; offset += 8) {
    const batch = await Promise.all(snapshots.slice(offset, offset + 8).map(async (snapshot) => ({
      snapshot,
      content: await readSnapshotText(env, snapshot, { maxBytes: KNOWLEDGE_ACTION_MAX_TEXT_BYTES, skipNonText: true })
    })));
    for (const { snapshot, content } of batch) {
      if (!content) { skippedFiles += 1; continue; }
      scannedFiles += 1;
      if (action === "search") {
        const bodyText = stripMarkup(content.text);
        const score = scoreSearchText(`${snapshot.relativePath}\n${bodyText}`, terms);
        if (score > 0) results.push({
          objectId: snapshot.objectId, versionId: snapshot.versionId,
          path: snapshot.path, relativePath: snapshot.relativePath,
          fileName: snapshot.fileName, contentKind: snapshot.contentKind,
          mimeType: content.mimeType, score, snippet: bestSnippet(bodyText, terms)
        });
        continue;
      }
      const lines = content.text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!(caseSensitive ? line : line.toLowerCase()).includes(needle)) continue;
        results.push({
          objectId: snapshot.objectId, versionId: snapshot.versionId,
          path: snapshot.path, relativePath: snapshot.relativePath,
          fileName: snapshot.fileName, contentKind: snapshot.contentKind,
          mimeType: content.mimeType, lineNumber: index + 1, line: line.slice(0, 800)
        });
      }
    }
  }
  if (action === "search") results.sort((left, right) => Number(right.score) - Number(left.score));
  return {
    folderObjectId,
    ...(action === "search" ? { query } : { pattern: query, caseSensitive }),
    results: results.slice(0, limit),
    scannedFiles,
    skippedFiles,
    truncated: results.length > limit
  };
}
