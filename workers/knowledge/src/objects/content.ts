import { HttpError } from "../http.ts";

// Shared content classification and validation for upload, edit and version persistence.

export function isDirectlyEditableKnowledgeFile(fileName: string, mimeType: string) {
  const lowerName = fileName.toLowerCase();
  return [
    ".txt", ".md", ".markdown", ".csv", ".json", ".jsonl", ".ndjson", ".html", ".htm"
  ].some((extension) => lowerName.endsWith(extension))
    || [
      "application/json",
      "application/x-ndjson",
      "text/csv",
      "text/html",
      "text/markdown",
      "text/plain"
    ].some((allowed) => mimeType.toLowerCase().split(";")[0] === allowed);
}

export function builtInKnowledgeIngestionDecision(
  fileName: string,
  mimeType: string,
  bytes: Uint8Array
): { reasonCode: string; status: "blocked" | "clean" | "pending" } {
  const textual = isDirectlyEditableKnowledgeFile(fileName, mimeType)
    || mimeType.toLowerCase().startsWith("text/");
  if (!textual) {
    return { reasonCode: "external_scanner_required", status: "pending" };
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { reasonCode: "invalid_utf8", status: "blocked" };
  }
  if (content.includes("\0")) {
    return { reasonCode: "nul_byte", status: "blocked" };
  }
  try {
    validateDirectEditContent(fileName, content);
  } catch {
    return { reasonCode: "structured_text_invalid", status: "blocked" };
  }
  return { reasonCode: "builtin_utf8_text", status: "clean" };
}

export function validateDirectEditContent(fileName: string, content: string) {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".json")) {
    try {
      JSON.parse(content);
    } catch {
      throw new HttpError(400, "knowledge_edit_invalid_json");
    }
  }
  if (lowerName.endsWith(".jsonl") || lowerName.endsWith(".ndjson")) {
    const lines = content.split(/\r?\n/).filter((line) => line.trim());
    try {
      lines.forEach((line) => JSON.parse(line));
    } catch {
      throw new HttpError(400, "knowledge_edit_invalid_jsonl");
    }
  }
}

export function isDiffableKnowledgeFile(fileName: string, mimeType: string) {
  return contentKindFromMime(mimeType, fileName) !== "binary"
    && !mimeType.startsWith("image/")
    && mimeType !== "application/pdf";
}

export function contentKindFromMime(mimeType: string, fileName: string) {
  const name = fileName.toLowerCase();
  const mediaType = mimeType.toLowerCase().split(";", 1)[0];
  if (mimeType.includes("html") || name.endsWith(".html") || name.endsWith(".htm")) return "html";
  if (mimeType.includes("markdown") || name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (mimeType.startsWith("image/")) return "image";
  if (mediaType === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mediaType === "text/csv" || mediaType === "application/csv" || name.endsWith(".csv")) return "csv";
  if (
    mimeType.startsWith("text/")
    || ["application/json", "application/x-ndjson"].includes(mimeType.toLowerCase().split(";")[0])
    || /\.(json|jsonl|ndjson)$/i.test(name)
  ) return "text";
  return "binary";
}

export function contentTypeFromName(fileName: string) {
  const name = fileName.toLowerCase();
  if (name.endsWith(".html") || name.endsWith(".htm")) return "text/html; charset=utf-8";
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "text/markdown; charset=utf-8";
  if (name.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (name.endsWith(".json")) return "application/json; charset=utf-8";
  if (name.endsWith(".jsonl") || name.endsWith(".ndjson")) return "application/x-ndjson; charset=utf-8";
  if (name.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

export async function sha256Hex(bytes: Uint8Array) {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Text(value: string) {
  return sha256Hex(new TextEncoder().encode(value));
}
