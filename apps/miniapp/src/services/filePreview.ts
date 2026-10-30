import type { LiveSession } from "../types";

export type FilePreviewKind = "html" | "markdown" | "image" | "pdf" | "document" | "unsupported";
export type FilePreviewSelection = {
  id: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  workspace?: { session: LiveSession; url: string };
};
let selectedFile: FilePreviewSelection | undefined;
export function selectFilePreview(file: FilePreviewSelection) { selectedFile = file; }
export function getFilePreview(id: string) { return selectedFile?.id === id ? selectedFile : undefined; }

export type DocumentFileType = "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "pdf";
const DOCUMENT_TYPES: Record<string, DocumentFileType> = {
  "application/pdf": "pdf", "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx"
};
export function documentFileType(name: string, mimeType = ""): DocumentFileType | undefined {
  const extension = name.toLowerCase().split(".").pop() || "";
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf"].includes(extension)) return extension as DocumentFileType;
  return DOCUMENT_TYPES[mimeType.split(";", 1)[0].trim().toLowerCase()];
}
/** User uploads, generated artifacts and Knowledge files use the same renderer. */
export function filePreviewKind(name: string, mimeType = ""): FilePreviewKind {
  const document = documentFileType(name, mimeType);
  if (document) return document === "pdf" ? "pdf" : "document";
  const extension = name.toLowerCase().split(".").pop() || "";
  const mediaType = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (["html", "htm"].includes(extension) || mediaType === "text/html") return "html";
  if (["md", "markdown", "mdown"].includes(extension) || ["text/markdown", "text/x-markdown"].includes(mediaType)) return "markdown";
  if (extension === "svg" || mediaType === "image/svg+xml") return "unsupported";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif"].includes(extension) || mediaType.startsWith("image/")) return "image";
  return "unsupported";
}
