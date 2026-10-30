import { callRuntimeWorkspacePassTool } from "../workspacePassMcpClient.ts";
import { RuntimeHttpError, type RuntimeEnv, type RuntimePrincipal } from "../types.ts";
import { nativePdfFromBytes, readAgentAttachment, type NativePdfPart } from "./documents.ts";
import type { MateToolContext, MateToolEnv } from "./types.ts";

/** Resolve original bytes through the owner/Mate-bound mail bridge, never a caller URL. */
export async function readMailAttachment(env: RuntimeEnv, toolEnv: MateToolEnv, context: MateToolContext,
  principal: RuntimePrincipal, mateId: string, messageId: string, attachmentId: string, signal?: AbortSignal,
  onNativePdf?: (part: NativePdfPart) => void) {
  const chunks: Uint8Array[] = [];
  let offset = 0, size = 0, filename = "", mimeType = "";
  while (true) {
    const chunk = await callRuntimeWorkspacePassTool(env, principal, "mail_get_attachment", { messageId, attachmentId, offset }, { mateId, signal }) as {
      totalBytes: number; offset: number; nextOffset: number | null; data: string; filename: string; mimeType: string;
    };
    if (!Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes <= 0 || chunk.totalBytes > 20 * 1024 * 1024
      || chunk.offset !== offset || (offset > 0 && chunk.totalBytes !== size)) throw new RuntimeHttpError(422, "mail_attachment_content_invalid");
    size = chunk.totalBytes; filename = chunk.filename; mimeType = chunk.mimeType;
    const bytes = Uint8Array.from(atob(chunk.data), value => value.charCodeAt(0));
    const end = offset + bytes.length;
    if (bytes.length === 0 || end > size || (end < size ? chunk.nextOffset !== end : chunk.nextOffset !== null)) {
      throw new RuntimeHttpError(422, "mail_attachment_content_invalid");
    }
    chunks.push(bytes);
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  }
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  const metadata = { messageId, attachmentId, sha256: digest, size, contentTrust: "untrusted_email" };
  if (onNativePdf) {
    const native = nativePdfFromBytes({ id: attachmentId, fileName: filename, mediaType: mimeType }, bytes);
    if (native) { onNativePdf(native.part); return { ...native.output, ...metadata }; }
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  const result = await readAgentAttachment(toolEnv, context, new Map([[attachmentId, {
    id: attachmentId, fileName: filename, mediaType: mimeType, dataUrl: `data:${mimeType};base64,${btoa(binary)}`
  }]]), attachmentId, signal);
  return { ...result, ...metadata };
}
