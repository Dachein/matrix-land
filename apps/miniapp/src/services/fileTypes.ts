const TYPES_BY_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", heic: "image/heic", heif: "image/heif", avif: "image/avif", tif: "image/tiff", tiff: "image/tiff",
  pdf: "application/pdf", md: "text/markdown", markdown: "text/markdown", html: "text/html", htm: "text/html", txt: "text/plain",
  csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", xml: "application/xml", zip: "application/zip",
  doc: "application/msword", docm: "application/vnd.ms-word.document.macroEnabled.12", xls: "application/vnd.ms-excel", xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12", ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rar: "application/vnd.rar", "7z": "application/x-7z-compressed", psd: "application/x-photoshop", dwg: "application/acad", cdr: "application/x-cdr", dxf: "application/dxf", stp: "application/step", rtf: "application/rtf", ai: "application/postscript",
  mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4"
};

export function resolvedMediaType(file: { name: string; type?: string }) {
  if (file.type && file.type !== "application/octet-stream" && /^[\w.+-]+\/[\w.+-]+$/.test(file.type)) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  return TYPES_BY_EXTENSION[extension] || "application/octet-stream";
}

/** WeChat forwarded materials often have a hash name without an extension. Preserve MIME routing. */
export function materialFileName(value: string, mimeType: string) {
  const name = value?.trim() || "未命名文件";
  if (/\.[a-z0-9]+$/i.test(name)) return name;
  const normalized = mimeType.split(";", 1)[0].trim().toLowerCase();
  const extension = Object.entries(TYPES_BY_EXTENSION).find(([, type]) => type.toLowerCase() === normalized)?.[0];
  return extension ? `${name}.${extension}` : name;
}
