import { RuntimeHttpError } from "./types.ts";

export type SourceMailOriginal = { fileName: string; mediaType: string; base64: string; size: number; sha256: string };
export async function sourceMailOriginal(attachment: { filename: string; size: number; sha256: string; mimeType: string }, read: (offset: number) => Promise<any>): Promise<SourceMailOriginal> {
  if (!Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > 20 * 1024 * 1024) throw new RuntimeHttpError(413, "mail_attachment_size_invalid");
  const bytes = new Uint8Array(attachment.size);
  let offset = 0;
  while (offset < bytes.length) {
    const chunk = await read(offset);
    if (chunk.offset !== offset || chunk.totalBytes !== bytes.length || chunk.filename !== attachment.filename) throw new RuntimeHttpError(422, "mail_attachment_content_invalid");
    let part: Uint8Array;
    try { part = Uint8Array.from(atob(chunk.data), value => value.charCodeAt(0)); } catch { throw new RuntimeHttpError(422, "mail_attachment_content_invalid"); }
    const end = offset + part.length;
    if (!part.length || end > bytes.length || (end < bytes.length ? chunk.nextOffset !== end : chunk.nextOffset !== null)) throw new RuntimeHttpError(422, "mail_attachment_content_invalid");
    bytes.set(part, offset); offset = end;
  }
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  if (sha256 !== attachment.sha256) throw new RuntimeHttpError(422, "mail_attachment_digest_mismatch");
  const mediaType = new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-" ? "application/pdf"
    : bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? "image/png"
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg" : attachment.mimeType;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { fileName: attachment.filename, mediaType, size: bytes.length, sha256, base64: btoa(binary) };
}

/** Only fills original bytes/metadata; the normal App adapter still authorizes the call. */
export function sourceMailAppArguments(file: SourceMailOriginal, inputSchema: unknown, args: Record<string, unknown>) {
  const properties = (inputSchema as { properties?: Record<string, { type?: string }> })?.properties;
  if (properties?.base64?.type !== "string" || Object.hasOwn(args, "base64")) throw new RuntimeHttpError(400, "mail_attachment_app_tool_invalid");
  return { ...args, base64: file.base64,
    ...(properties.file_name ? { file_name: file.fileName } : {}),
    ...(properties.mime_type ? { mime_type: file.mediaType } : {}) };
}
