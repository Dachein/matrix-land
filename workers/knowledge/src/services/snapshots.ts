import { HttpError } from "../http.ts";
import { requireVersion } from "../objects/repository.ts";
import { normalizePath } from "../paths.ts";
import { KNOWLEDGE_ACTION_MAX_CONTENT_CHARS, KNOWLEDGE_ACTION_MAX_READ_BYTES } from "../policy.ts";
import type { Env, KnowledgeServiceSnapshot, KnowledgeServiceVersionRow } from "../types.ts";
import { bytesToBase64, readString, safeJsonRecordArray } from "../values.ts";

// Read immutable service snapshots with existing file-size and encoding boundaries.
export function knowledgeServiceSnapshots(version: KnowledgeServiceVersionRow): KnowledgeServiceSnapshot[] {
  return safeJsonRecordArray(version.object_versions_json)
    .map((record) => ({
      objectId: readString(record.objectId),
      versionId: readString(record.versionId),
      path: readString(record.path),
      relativePath: readString(record.relativePath),
      fileName: readString(record.fileName),
      contentKind: readString(record.contentKind),
      mimeType: readString(record.mimeType),
      sizeBytes: Number(record.sizeBytes ?? 0),
      sha256: readString(record.sha256),
      isHandbook: record.isHandbook === true
    }))
    .filter((snapshot) => snapshot.objectId && snapshot.versionId && snapshot.relativePath);
}

export function findKnowledgeSnapshot(snapshots: KnowledgeServiceSnapshot[], body: Record<string, unknown>) {
  const objectId = readString(body.objectId ?? body.fileObjectId).trim();
  if (objectId) {
    return snapshots.find((snapshot) => snapshot.objectId === objectId);
  }
  const requestedPath = normalizePath(readString(body.relativePath ?? body.path ?? body.filePath));
  if (!requestedPath) {
    throw new HttpError(400, "missing_knowledge_service_file");
  }
  return snapshots.find((snapshot) => snapshot.relativePath === requestedPath || snapshot.path === requestedPath);
}

export async function readSnapshotText(
  env: Env,
  snapshot: KnowledgeServiceSnapshot,
  options: { maxBytes: number; skipNonText: boolean }
) {
  if (options.skipNonText && !isTextualSnapshot(snapshot)) {
    return null;
  }
  const version = await requireVersion(env, snapshot.versionId);
  if (version.size_bytes > options.maxBytes) {
    return null;
  }
  const r2Object = await env.KNOWLEDGE_OBJECTS.get(version.r2_key);
  if (!r2Object) {
    throw new HttpError(404, "knowledge_service_object_missing");
  }
  const bytes = new Uint8Array(await r2Object.arrayBuffer());
  return {
    mimeType: version.mime_type || snapshot.mimeType,
    sizeBytes: bytes.byteLength,
    text: new TextDecoder().decode(bytes)
  };
}

export async function readSnapshotContent(env: Env, snapshot: KnowledgeServiceSnapshot) {
  const version = await requireVersion(env, snapshot.versionId);
  if (version.size_bytes > KNOWLEDGE_ACTION_MAX_READ_BYTES) {
    throw new HttpError(413, "knowledge_service_file_too_large");
  }
  const r2Object = await env.KNOWLEDGE_OBJECTS.get(version.r2_key);
  if (!r2Object) {
    throw new HttpError(404, "knowledge_service_object_missing");
  }
  const bytes = new Uint8Array(await r2Object.arrayBuffer());
  const mimeType = version.mime_type || snapshot.mimeType || "application/octet-stream";
  if (isTextualSnapshot({ ...snapshot, mimeType })) {
    const text = new TextDecoder().decode(bytes);
    return {
      encoding: "text",
      mimeType,
      sizeBytes: bytes.byteLength,
      text: text.slice(0, KNOWLEDGE_ACTION_MAX_CONTENT_CHARS),
      truncated: text.length > KNOWLEDGE_ACTION_MAX_CONTENT_CHARS
    };
  }
  return {
    encoding: "base64",
    mimeType,
    sizeBytes: bytes.byteLength,
    base64: bytesToBase64(bytes),
    truncated: false
  };
}

export function isTextualSnapshot(snapshot: Pick<KnowledgeServiceSnapshot, "contentKind" | "mimeType" | "fileName">) {
  const contentKind = snapshot.contentKind.toLowerCase();
  const mimeType = snapshot.mimeType.toLowerCase();
  const fileName = snapshot.fileName.toLowerCase();
  return (
    ["markdown", "text", "html", "json", "csv"].includes(contentKind)
    || mimeType.startsWith("text/")
    || ["application/json", "application/x-ndjson", "application/xml", "application/javascript"].includes(mimeType.split(";")[0])
    || /\.(md|markdown|txt|html|htm|json|jsonl|ndjson|csv|tsv|xml|yaml|yml|sql|js|ts|tsx|jsx|css)$/i.test(fileName)
  );
}
