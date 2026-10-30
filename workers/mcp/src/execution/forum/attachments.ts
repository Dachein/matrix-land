import { readNumber, readString } from "../../http.ts";
import { MAX_FORUM_ATTACHMENT_BYTES, MAX_FORUM_ATTACHMENTS } from "../../toolDefinitions/shared.ts";
import { type Env, HttpError } from "../../types.ts";
import { optionalText } from "../values.ts";
import { forumImageFileName } from "./media.ts";

type McpForumAttachmentRequest = {
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  storageKey: string;
};

type McpForumAttachment = {
  fileName: string;
  fileSize: number;
  mimeType: string;
  publicUrl: string;
  storageKey: string;
};

export function sanitizeMcpForumAttachmentRequests(value: unknown): McpForumAttachmentRequest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_forum_attachments");
  if (value.length > MAX_FORUM_ATTACHMENTS) throw new HttpError(400, "too_many_forum_attachments");

  const seen = new Set<string>();
  const attachments: McpForumAttachmentRequest[] = [];

  value.forEach((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, "invalid_forum_attachment");
    }
    const record = item as Record<string, unknown>;
    const storageProvider = readString(record.storageProvider).trim() || "r2";
    const storageKey = readString(record.storageKey).trim();
    if (storageProvider !== "r2" || !validMcpForumStorageKey(storageKey)) {
      throw new HttpError(400, "invalid_forum_attachment");
    }
    if (seen.has(storageKey)) return;
    seen.add(storageKey);
    attachments.push({
      fileName: optionalText(record.fileName, 180) || undefined,
      fileSize: readNumber(record.fileSize) || undefined,
      mimeType: optionalText(record.mimeType, 120) || undefined,
      storageKey
    });
  });

  return attachments;
}

export async function resolveMcpForumAttachments(
  env: Env,
  requests: McpForumAttachmentRequest[],
  ownerUserId: string
): Promise<McpForumAttachment[]> {
  if (requests.length === 0) return [];
  const bucket = env.FORUM_MEDIA;
  if (!bucket) throw new HttpError(503, "forum_media_not_configured");
  const attachments: McpForumAttachment[] = [];

  for (const request of requests) {
    const existing = await env.DB
      .prepare("SELECT id FROM forum_attachments WHERE storage_key = ? LIMIT 1")
      .bind(request.storageKey)
      .first<{ id: string }>();
    if (existing) throw new HttpError(409, "forum_media_already_attached");

    const object = await bucket.head(request.storageKey);
    if (!object) throw new HttpError(404, "forum_media_not_found");
    if (readString(object.customMetadata?.ownerUserId) !== ownerUserId) {
      throw new HttpError(403, "forum_media_attach_forbidden");
    }

    const fileSize = Number(object.size);
    if (!Number.isFinite(fileSize) || fileSize <= 0) throw new HttpError(400, "empty_forum_attachment");
    if (fileSize > MAX_FORUM_ATTACHMENT_BYTES) throw new HttpError(400, "forum_attachment_too_large");

    const fileName = forumImageFileName(
      readString(object.customMetadata?.originalFileName) || request.fileName || request.storageKey.split("/").at(-1) || "attachment"
    );
    const mimeType = normalizeMcpForumAttachmentMime(
      readString(object.httpMetadata?.contentType) || request.mimeType || "",
      fileName
    );

    attachments.push({
      fileName,
      fileSize,
      mimeType,
      publicUrl: `/api/forum/media/${request.storageKey}`,
      storageKey: request.storageKey
    });
  }

  return attachments;
}

function validMcpForumStorageKey(value: string) {
  return value.startsWith("forum/") && value.length < 260 && !value.includes("..") && /^[a-zA-Z0-9/_.,@()\-]+$/.test(value);
}

function normalizeMcpForumAttachmentMime(value: string, fileName: string) {
  const normalized = value.toLowerCase().split(";")[0].trim();
  const allowed = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/pdf",
    "text/markdown",
    "text/x-markdown",
    "text/html",
    "application/xhtml+xml"
  ]);
  if (allowed.has(normalized)) return normalized;

  const extension = fileName.toLowerCase().split(".").at(-1) ?? "";
  const byExtension: Record<string, string> = {
    gif: "image/gif",
    htm: "text/html",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    markdown: "text/markdown",
    md: "text/markdown",
    pdf: "application/pdf",
    png: "image/png",
    webp: "image/webp"
  };
  const detected = byExtension[extension];
  if (detected && allowed.has(detected)) return detected;
  throw new HttpError(400, "unsupported_forum_attachment_type");
}
