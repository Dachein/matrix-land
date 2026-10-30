import type { ForumAttachmentRecord, ForumContext, ForumDeps, ForumEnv } from "./types.ts";

export const MAX_FORUM_ATTACHMENTS = 16;
export const MAX_FORUM_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const ALLOWED_FORUM_ATTACHMENT_TYPES = new Set([
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

export function createForumMediaApi<TEnv extends ForumEnv>(deps: ForumDeps<TEnv>) {
  return {
    async uploadForumMedia(context: ForumContext<TEnv>) {
      const bucket = requireForumMediaBucket(context.env.FORUM_MEDIA, deps);
      const currentUser = await deps.resolveCurrentUser(context);
      const contentType = context.request.headers.get("content-type") ?? "";

      if (!contentType.includes("multipart/form-data")) {
        throw deps.httpError(400, "multipart_form_required");
      }

      const formData = await context.request.formData();
      const files = [
        ...formData.getAll("attachments"),
        ...formData.getAll("images"),
        ...formData.getAll("files")
      ].filter((value): value is File => value instanceof File);

      if (files.length === 0) {
        throw deps.httpError(400, "missing_forum_media");
      }

      if (files.length > MAX_FORUM_ATTACHMENTS) {
        throw deps.httpError(400, "too_many_forum_attachments");
      }

      const attachments: ForumAttachmentRecord[] = [];

      for (const file of files) {
        const normalized = normalizeForumUploadFile(file, deps);
        const storageKey = forumMediaStorageKey(normalized.fileName);

        await bucket.put(storageKey, file.stream(), {
          httpMetadata: {
            contentType: normalized.mimeType,
            contentDisposition: `${inlineForumMedia(normalized.mimeType) ? "inline" : "attachment"}; filename="${headerSafeFilename(normalized.fileName)}"`
          },
          customMetadata: {
            ownerUserId: currentUser.id,
            originalFileName: normalized.fileName
          }
        });

        attachments.push({
          storageProvider: "r2",
          storageKey,
          publicUrl: forumMediaPublicUrl(storageKey),
          mimeType: normalized.mimeType,
          fileName: normalized.fileName,
          fileSize: file.size
        });
      }

      return { attachments };
    },

    async getForumMedia(context: ForumContext<TEnv>, rawKey: string) {
      const bucket = requireForumMediaBucket(context.env.FORUM_MEDIA, deps);
      const storageKey = decodeURIComponent(rawKey);

      if (!validForumStorageKey(storageKey)) {
        throw deps.httpError(400, "invalid_forum_media_key");
      }

      const object = await bucket.get(storageKey);

      if (!object) {
        throw deps.httpError(404, "forum_media_not_found");
      }

      const originalType = object.httpMetadata?.contentType ?? "application/octet-stream";
      const safeType = safeServedForumMediaType(originalType);
      const fileName = headerSafeFilename(object.customMetadata?.originalFileName ?? storageKey.split("/").at(-1) ?? "attachment");
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Content-Type", safeType);
      headers.set("Cache-Control", "private, max-age=31536000, immutable");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Content-Disposition", `${inlineForumMedia(originalType) ? "inline" : "attachment"}; filename="${fileName}"`);

      return new Response(object.body, { headers });
    },

    async deleteForumMediaDraft(context: ForumContext<TEnv>, rawKey: string) {
      const bucket = requireForumMediaBucket(context.env.FORUM_MEDIA, deps);
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const storageKey = decodeURIComponent(rawKey);

      if (!validForumStorageKey(storageKey)) {
        throw deps.httpError(400, "invalid_forum_media_key");
      }

      const object = await bucket.head(storageKey);
      if (!object) return { deleted: true };

      if (object.customMetadata?.ownerUserId !== currentUser.id) {
        throw deps.httpError(403, "forum_media_delete_forbidden");
      }

      const attachment = await db
        .prepare("SELECT id FROM forum_attachments WHERE storage_key = ? LIMIT 1")
        .bind(storageKey)
        .first<{ id: string }>();
      if (attachment) {
        throw deps.httpError(409, "forum_media_already_attached");
      }

      await bucket.delete(storageKey);
      return { deleted: true };
    }
  };
}

function requireForumMediaBucket<TEnv extends ForumEnv>(bucket: R2Bucket | undefined, deps: ForumDeps<TEnv>) {
  if (!bucket) {
    throw deps.httpError(503, "forum_media_not_configured");
  }

  return bucket;
}

function normalizeForumUploadFile<TEnv extends ForumEnv>(file: File, deps: ForumDeps<TEnv>) {
  const fileName = displayForumFileName(file.name);
  const mimeType = normalizeForumAttachmentMime(fileName, file.type);

  if (!mimeType) {
    throw deps.httpError(400, "unsupported_forum_attachment_type");
  }

  if (file.size <= 0) {
    throw deps.httpError(400, "empty_forum_attachment");
  }

  if (file.size > MAX_FORUM_ATTACHMENT_BYTES) {
    throw deps.httpError(400, "forum_attachment_too_large");
  }

  return { fileName, mimeType };
}

export function sanitizeForumAttachments<TEnv extends ForumEnv>(value: unknown, deps: ForumDeps<TEnv>): ForumAttachmentRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const attachments: ForumAttachmentRecord[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const storageProvider = readString(record.storageProvider) || "r2";
    const storageKey = readString(record.storageKey);
    const fileName = displayForumFileName(readString(record.fileName) || storageKey.split("/").at(-1) || "attachment");
    const mimeType = normalizeForumAttachmentMime(fileName, readString(record.mimeType));
    const fileSize = readNumber(record.fileSize);

    if (storageProvider !== "r2" || !validForumStorageKey(storageKey) || !mimeType || fileSize <= 0 || fileSize > MAX_FORUM_ATTACHMENT_BYTES) {
      throw deps.httpError(400, "invalid_forum_attachment");
    }

    if (!seen.has(storageKey)) {
      seen.add(storageKey);
      attachments.push({
        storageProvider: "r2",
        storageKey,
        publicUrl: forumMediaPublicUrl(storageKey),
        mimeType,
        fileName,
        fileSize
      });
    }

    if (attachments.length >= MAX_FORUM_ATTACHMENTS) {
      break;
    }
  }

  return attachments;
}

export function sanitizeForumImageAttachments<TEnv extends ForumEnv>(value: unknown, deps: ForumDeps<TEnv>): ForumAttachmentRecord[] {
  const attachments = sanitizeForumAttachments(value, deps);

  if (attachments.some((attachment) => !attachment.mimeType.startsWith("image/"))) {
    throw deps.httpError(400, "invalid_forum_reply_attachment");
  }

  return attachments;
}

function normalizeForumAttachmentMime(fileName: string, mimeType: string) {
  const normalized = mimeType.toLowerCase().split(";")[0].trim();

  if (ALLOWED_FORUM_ATTACHMENT_TYPES.has(normalized)) {
    return normalized;
  }

  const extension = fileName.toLowerCase().split(".").at(-1) ?? "";
  const byExtension: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
    md: "text/markdown",
    markdown: "text/markdown",
    html: "text/html",
    htm: "text/html"
  };
  const detected = byExtension[extension];
  return detected && ALLOWED_FORUM_ATTACHMENT_TYPES.has(detected) ? detected : undefined;
}

function displayForumFileName(value: string) {
  return (value.split(/[\\/]/).pop() ?? "").trim().slice(0, 180) || "attachment";
}

function forumMediaStorageKey(fileName: string) {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `forum/${year}/${month}/${crypto.randomUUID()}-${storageSafeFilename(fileName)}`;
}

function storageSafeFilename(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^\w. -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "attachment";
}

function forumMediaPublicUrl(storageKey: string) {
  return `/api/forum/media/${storageKey}`;
}

export function validForumStorageKey(value: string) {
  return value.startsWith("forum/") && value.length < 260 && !value.includes("..") && /^[a-zA-Z0-9/_.,@()\-]+$/.test(value);
}

function inlineForumMedia(mimeType: string) {
  const type = mimeType.toLowerCase();
  return type.startsWith("image/") || type.startsWith("audio/") || type === "application/pdf" || type === "text/markdown" || type === "text/x-markdown";
}

function safeServedForumMediaType(mimeType: string) {
  const type = mimeType.toLowerCase();

  if (type === "text/html" || type === "application/xhtml+xml") {
    return "text/plain; charset=utf-8";
  }

  if (type === "text/markdown" || type === "text/x-markdown") {
    return `${type}; charset=utf-8`;
  }

  return type;
}

function headerSafeFilename(value: string) {
  return value.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_").slice(0, 140) || "attachment";
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}
