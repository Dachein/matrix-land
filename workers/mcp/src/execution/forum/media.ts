import { missingConfiguration } from "../../../../../src/shared/requiredConfiguration.ts";
import { readString } from "../../http.ts";
import { MAX_UPLOAD_BYTES } from "../../toolDefinitions/index.ts";
import { type Env, HttpError, type Principal } from "../../types.ts";
import { requireText } from "../values.ts";
import { ensureForumUser } from "./identity.ts";

// Own forum media persistence and principal-bound upload sessions.
const MEDIA_UPLOAD_SESSION_TTL_MS = 15 * 60 * 1000;

export async function uploadForumMedia(env: Env, args: Record<string, unknown>, principal: Principal) {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) {
    throw new HttpError(400, "missing_forum_media_url");
  }
  if (!/^https:\/\//i.test(url)) {
    throw new HttpError(400, "forum_media_url_must_be_https");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": "workspace-mcp-worker", Accept: "*/*" },
      redirect: "follow"
    });
  } catch {
    throw new HttpError(502, "forum_media_url_unreachable");
  }
  if (!response.ok) {
    throw new HttpError(502, "forum_media_url_fetch_failed");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  const requestedMime = typeof args.mimeType === "string" ? args.mimeType : "";
  const mimeType = normalizeForumMediaMime(requestedMime || contentType.split(";")[0].trim() || "application/octet-stream");
  const requestedName = typeof args.fileName === "string" ? args.fileName : "";
  const fileName = forumImageFileName(requestedName || url.split(/[\\/]/).pop() || "attachment");

  return storeForumMediaBytes(env, principal, bytes, mimeType, fileName);
}

async function storeForumMediaBytes(env: Env, principal: Principal, bytes: Uint8Array, mimeType: string, fileName: string) {
  const bucket = env.FORUM_MEDIA;
  if (!bucket) {
    throw new HttpError(503, "forum_media_not_configured");
  }
  const normalizedType = normalizeForumMediaMime(mimeType);
  const isImage = normalizedType.startsWith("image/");
  if (bytes.byteLength === 0) {
    throw new HttpError(400, "empty_forum_media");
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new HttpError(400, "forum_media_too_large");
  }
  if (isImage && !forumImageSignatureMatches(bytes, normalizedType)) {
    throw new HttpError(400, "forum_media_type_mismatch");
  }

  const author = await ensureForumUser(env, principal);
  const storageKey = forumImageStorageKey(fileName);
  const publicUrl = `/api/forum/media/${storageKey}`;

  await bucket.put(storageKey, bytes, {
    httpMetadata: {
      contentDisposition: `${isImage ? "inline" : "attachment"}; filename="${forumImageHeaderFileName(fileName)}"`,
      contentType: normalizedType
    },
    customMetadata: {
      ownerUserId: author.id,
      originalFileName: fileName,
      uploadedVia: "workspace-mcp"
    }
  });

  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
       VALUES (?, 'user', ?, 'uploaded forum media from MCP', 'forum_media', ?, ?)`
    ).bind(crypto.randomUUID(), author.id, storageKey, JSON.stringify({
      agentType: principal.agentType,
      connectionId: principal.connectionId,
      fileName,
      fileSize: bytes.byteLength,
      mimeType: normalizedType
    })).run();
  } catch (error) {
    await bucket.delete(storageKey).catch(() => undefined);
    throw error;
  }

  return {
    fileName,
    fileSize: bytes.byteLength,
    mimeType: normalizedType,
    publicUrl,
    storageKey,
    url: `${(env.PORTAL_URL ?? missingConfiguration("PORTAL_URL")).replace(/\/$/, "")}${publicUrl}`
  };
}

function forumImageSignatureMatches(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    return bytes.length >= 6 && (
      String.fromCharCode(...bytes.slice(0, 6)) === "GIF89a" ||
      String.fromCharCode(...bytes.slice(0, 6)) === "GIF87a"
    );
  }
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
}

export async function beginUpload(env: Env, args: Record<string, unknown>, principal: Principal) {
  const fileName = forumImageFileName(requireText(args.fileName, "missing_upload_file_name", 180));
  const mimeType = normalizeForumMediaMime(requireText(args.mimeType, "missing_upload_mime", 120));
  const declaredSize = typeof args.size === "number" && Number.isFinite(args.size) ? Math.max(0, Math.floor(args.size)) : 0;
  if (declaredSize > MAX_UPLOAD_BYTES) {
    throw new HttpError(400, "upload_too_large");
  }

  const author = await ensureForumUser(env, principal);
  const uploadId = crypto.randomUUID();
  const r2Key = forumImageStorageKey(fileName);
  const expiresAt = Date.now() + MEDIA_UPLOAD_SESSION_TTL_MS;

  await env.DB.prepare(
    `INSERT INTO media_upload_sessions (upload_id, r2_key, file_name, mime_type, declared_size, expires_at, status, owner_user_id)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(uploadId, r2Key, fileName, mimeType, declaredSize, expiresAt, author.id).run();

  const baseUrl = (env.MCP_RESOURCE_URL ?? missingConfiguration("MCP_RESOURCE_URL")).replace(/\/$/, "");
  return {
    uploadId,
    r2Key,
    fileName,
    mimeType,
    expiresAt,
    maxBytes: MAX_UPLOAD_BYTES,
    uploadUrl: `${baseUrl}/api/media-upload/${uploadId}`
  };
}

export async function finalizeUpload(env: Env, args: Record<string, unknown>, principal: Principal) {
  const uploadId = requireText(args.uploadId, "missing_upload_id", 120);
  const r2Key = requireText(args.r2Key, "missing_upload_r2_key", 260);
  const fileName = forumImageFileName(requireText(args.fileName, "missing_upload_file_name", 180));
  const mimeType = normalizeForumMediaMime(requireText(args.mimeType, "missing_upload_mime", 120));

  const ticket = await env.DB.prepare(
    `SELECT upload_id, r2_key, file_name, mime_type, expires_at, status, owner_user_id
     FROM media_upload_sessions WHERE upload_id = ?`
  ).bind(uploadId).first<{ r2_key: string; status: string; expires_at: number }>();
  if (!ticket) {
    throw new HttpError(404, "upload_session_not_found");
  }
  if (ticket.r2_key !== r2Key) {
    throw new HttpError(400, "upload_r2_key_mismatch");
  }
  if (ticket.status !== "pending") {
    throw new HttpError(409, "upload_already_finalized");
  }
  if (Number(ticket.expires_at) < Date.now()) {
    throw new HttpError(410, "upload_session_expired");
  }

  const bucket = env.FORUM_MEDIA;
  if (!bucket) {
    throw new HttpError(503, "forum_media_not_configured");
  }
  const object = await bucket.get(r2Key);
  if (!object) {
    throw new HttpError(404, "upload_object_missing");
  }
  if (object.size <= 0) {
    throw new HttpError(400, "empty_upload");
  }
  if (object.size > MAX_UPLOAD_BYTES) {
    throw new HttpError(400, "upload_too_large");
  }

  const author = await ensureForumUser(env, principal);
  await env.DB.prepare(
    `UPDATE media_upload_sessions SET status = 'finalized', finalized_at = CURRENT_TIMESTAMP, owner_user_id = ?
     WHERE upload_id = ?`
  ).bind(author.id, uploadId).run();

  const publicUrl = `/api/forum/media/${r2Key}`;
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
     VALUES (?, 'user', ?, 'uploaded forum media from MCP', 'forum_media', ?, ?)`
  ).bind(crypto.randomUUID(), author.id, r2Key, JSON.stringify({
    agentType: principal.agentType,
    connectionId: principal.connectionId,
    fileName,
    fileSize: object.size,
    mimeType,
    uploadId
  })).run();

  return {
    file: {
      fileName,
      fileSize: object.size,
      mimeType,
      storageKey: r2Key,
      publicUrl,
      url: `${(env.PORTAL_URL ?? missingConfiguration("PORTAL_URL")).replace(/\/$/, "")}${publicUrl}`
    }
  };
}

export function normalizeForumMediaMime(value: unknown) {
  const mimeType = readString(value).trim().toLowerCase();
  if (!mimeType) {
    return "application/octet-stream";
  }
  const base = mimeType.split(";")[0].trim();
  if (base === "image/gif" || base === "image/jpeg" || base === "image/png" || base === "image/webp") {
    return base;
  }
  if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base)) {
    return base;
  }
  throw new HttpError(400, "unsupported_forum_media_type");
}

export function forumImageFileName(value: string) {
  return (value.split(/[\\/]/).pop() ?? "").trim().slice(0, 180) || "image";
}

function forumImageStorageKey(fileName: string) {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const safeName = fileName
    .normalize("NFKD")
    .replace(/[^\w. -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "image";
  return `forum/${year}/${month}/${crypto.randomUUID()}-${safeName}`;
}

export function forumImageHeaderFileName(value: string) {
  return value.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_").slice(0, 140) || "image";
}
