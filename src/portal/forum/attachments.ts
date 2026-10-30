import type { PendingForumAttachment, UploadedForumAttachment } from "./types";

export async function uploadForumAttachments(attachments: PendingForumAttachment[], signal?: AbortSignal) {
  const formData = new FormData();
  attachments.forEach((attachment) => {
    formData.append("attachments", attachment.file, attachment.file.name);
  });

  const response = await fetch("/api/forum/media", {
    method: "POST",
    body: formData,
    signal
  });

  if (!response.ok) {
    throw new Error("upload_forum_attachments_failed");
  }

  const payload = await response.json() as { attachments?: UploadedForumAttachment[] };
  return payload.attachments ?? [];
}

export async function discardForumUploads(attachments: UploadedForumAttachment[]) {
  await Promise.allSettled(
    attachments.map((attachment) => fetch(`/api/forum/media/${encodeURIComponent(attachment.storageKey)}`, {
      keepalive: true,
      method: "DELETE"
    }))
  );
}

export function normalizeBrowserAttachmentMime(file: File) {
  const type = file.type.toLowerCase().split(";")[0].trim();

  if (allowedBrowserAttachmentTypes().has(type)) {
    return type;
  }

  const extension = file.name.toLowerCase().split(".").at(-1) ?? "";
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
  return detected && allowedBrowserAttachmentTypes().has(detected) ? detected : undefined;
}

export function normalizeBrowserImageAttachmentMime(file: File) {
  const mimeType = normalizeBrowserAttachmentMime(file);
  return mimeType?.startsWith("image/") ? mimeType : undefined;
}

function allowedBrowserAttachmentTypes() {
  return new Set([
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
}

export function fileLabel(mimeType = "") {
  if (mimeType.startsWith("image/")) {
    return "Image";
  }

  if (mimeType === "application/pdf") {
    return "PDF";
  }

  if (mimeType === "text/markdown" || mimeType === "text/x-markdown") {
    return "Markdown";
  }

  if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
    return "HTML";
  }

  return "File";
}

export function fileKind(mimeType = "") {
  if (mimeType === "application/pdf") {
    return "pdf";
  }

  if (mimeType === "text/markdown" || mimeType === "text/x-markdown") {
    return "markdown";
  }

  if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
    return "html";
  }

  return "file";
}

export function filePreviewText(mimeType = "") {
  if (mimeType === "application/pdf") {
    return "Open the PDF preview in a new tab.";
  }

  if (mimeType === "text/markdown" || mimeType === "text/x-markdown") {
    return "Markdown source is stored as a reusable AI-friendly attachment.";
  }

  if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
    return "HTML is served safely as a file, not executed inside the forum.";
  }

  return "Open or download this attachment.";
}
