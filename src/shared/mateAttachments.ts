/** One format policy for the picker, client validation, and Runtime ingress. */
export const MATE_DOCUMENT_EXTENSIONS = [
  ".csv", ".docx", ".htm", ".html", ".markdown", ".md", ".numbers",
  ".ods", ".odt", ".pdf", ".pptx", ".txt", ".xls", ".xlsb", ".xlsm", ".xlsx", ".xml", ".zip"
] as const;

export function mateAttachmentKind(fileName: string, mediaType: string): "image" | "document" | undefined {
  const extension = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  if (mediaType.toLowerCase().startsWith("image/") || [".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"].includes(extension)) return "image";
  if ((MATE_DOCUMENT_EXTENSIONS as readonly string[]).includes(extension) || mediaType.toLowerCase() === "application/pdf") return "document";
}
