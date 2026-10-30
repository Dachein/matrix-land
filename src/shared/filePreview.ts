export type FilePreviewKind = "audio" | "csv" | "download" | "html" | "image" | "markdown" | "pdf" | "text" | "video";

export type CsvPreview = {
  rows: string[][];
  truncatedColumns: boolean;
  truncatedRows: boolean;
};

export function filePreviewKind(fileName: string, mimeType = ""): FilePreviewKind {
  const extension = fileName.split(".").pop()?.trim().toLowerCase() ?? "";
  const mediaType = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (["mp3", "m4a", "wav", "ogg", "oga", "flac", "aac"].includes(extension)) return "audio";
  if (["mp4", "mov", "m4v", "webm"].includes(extension)) return "video";
  if (mediaType === "application/pdf" || extension === "pdf") return "pdf";
  if (mediaType === "text/html" || extension === "html" || extension === "htm") return "html";
  if (mediaType === "text/csv" || mediaType === "application/csv" || extension === "csv") return "csv";
  if (mediaType === "text/markdown" || extension === "md" || extension === "markdown") return "markdown";
  if (mediaType.startsWith("text/") || ["json", "txt"].includes(extension)) return "text";
  return "download";
}

/**
 * Parses RFC 4180-style CSV for an on-screen preview. The bounded result prevents a
 * large generated artifact from creating an unbounded number of DOM nodes.
 */
export function parseCsvPreview(source: string, options: { maxColumns?: number; maxRows?: number } = {}): CsvPreview {
  const maxColumns = positiveLimit(options.maxColumns, 100);
  const maxRows = positiveLimit(options.maxRows, 2_000);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncatedColumns = false;
  let truncatedRows = false;
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;

  const pushField = () => {
    if (row.length < maxColumns) row.push(field);
    else truncatedColumns = true;
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (rows.length < maxRows) rows.push(row);
    else truncatedRows = true;
    row = [];
  };

  for (; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"' && field.length === 0) { quoted = true; continue; }
    if (character === ",") { pushField(); continue; }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      pushRow();
      if (truncatedRows) break;
      continue;
    }
    field += character;
  }

  if (!truncatedRows && (field.length > 0 || row.length > 0)) pushRow();
  return { rows, truncatedColumns, truncatedRows };
}

function positiveLimit(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
