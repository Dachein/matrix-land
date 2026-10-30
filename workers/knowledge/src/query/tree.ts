import { HttpError } from "../http.ts";
import { joinPath, normalizePath, relativeKnowledgePath } from "../paths.ts";
import { requireReadableKnowledgeService } from "../services/access.ts";
import { knowledgeServiceJson } from "../services/representation.ts";
import type { Env, ObjectRow, Principal } from "../types.ts";
import { readString } from "../values.ts";
import { readLimit } from "./text.ts";

export async function knowledgeServiceTree(
  env: Env,
  principal: Principal,
  serviceId: string,
  body: Record<string, unknown>
) {
  const readable = await requireReadableKnowledgeService(env, principal, serviceId);
  const relativeParent = normalizePath(readString(body.relativePath ?? body.path));
  const depth = readLimit(body.depth, 2, 10);
  const limit = readLimit(body.limit, 200, 1_000);
  const absoluteParent = relativeParent
    ? joinPath(readable.folder.path, relativeParent)
    : readable.folder.path;
  if (
    absoluteParent !== readable.folder.path
    && !absoluteParent.startsWith(`${readable.folder.path}/`)
  ) {
    throw new HttpError(400, "knowledge_service_path_outside_root");
  }
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT object.*
       FROM knowledge_objects AS object
       WHERE object.namespace_id = ?
         AND object.deleted_at IS NULL
         AND (
           object.parent_path = ?
           OR substr(object.path, 1, length(?) + 1) = ? || '/'
         )
       ORDER BY object.object_kind = 'folder' DESC, lower(object.path)
       LIMIT ?`
    )
    .bind(
      readable.row.namespace_id,
      absoluteParent,
      absoluteParent,
      absoluteParent,
      Math.min(5_000, limit * Math.max(2, depth))
    )
    .all<ObjectRow>();
  const baseSegments = absoluteParent.split("/").filter(Boolean).length;
  const items = (rows.results ?? [])
    .filter((row) => row.path.split("/").filter(Boolean).length - baseSegments <= depth)
    .slice(0, limit)
    .map(knowledgeServiceMetadataItem(readable.folder.path));
  return {
    depth,
    items,
    relativePath: relativeParent,
    rootObjectId: readable.folder.id,
    service: knowledgeServiceJson(readable.row, undefined, readable.effectiveRole),
    truncated: items.length >= limit
  };
}

export async function knowledgeServiceGlob(
  env: Env,
  principal: Principal,
  serviceId: string,
  body: Record<string, unknown>
) {
  const readable = await requireReadableKnowledgeService(env, principal, serviceId);
  const pattern = readString(body.pattern ?? body.glob).trim();
  if (!pattern) {
    throw new HttpError(400, "missing_knowledge_service_glob_pattern");
  }
  if (pattern.length > 200 || pattern.includes("\0")) {
    throw new HttpError(400, "invalid_knowledge_service_glob_pattern");
  }
  const limit = readLimit(body.limit, 200, 1_000);
  const matcher = knowledgeGlobRegex(pattern);
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT object.*
       FROM knowledge_objects AS object
       WHERE object.namespace_id = ?
         AND object.deleted_at IS NULL
         AND substr(object.path, 1, length(?) + 1) = ? || '/'
       ORDER BY lower(object.path)
       LIMIT 5000`
    )
    .bind(readable.row.namespace_id, readable.folder.path, readable.folder.path)
    .all<ObjectRow>();
  const matches = (rows.results ?? [])
    .filter((row) => matcher.test(relativeKnowledgePath(readable.folder.path, row.path)))
    .slice(0, limit)
    .map(knowledgeServiceMetadataItem(readable.folder.path));
  return {
    items: matches,
    pattern,
    rootObjectId: readable.folder.id,
    service: knowledgeServiceJson(readable.row, undefined, readable.effectiveRole),
    truncated: matches.length >= limit
  };
}

function knowledgeServiceMetadataItem(rootPath: string) {
  return (row: ObjectRow) => ({
    contentKind: row.content_kind,
    fileName: row.file_name,
    kind: row.object_kind,
    mimeType: row.mime_type,
    objectId: row.id,
    path: row.path,
    relativePath: relativeKnowledgePath(rootPath, row.path),
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    updatedAt: row.updated_at,
    versionId: row.current_version_id
  });
}

function knowledgeGlobRegex(pattern: string) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$.[\]{}()+|]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "u");
}
