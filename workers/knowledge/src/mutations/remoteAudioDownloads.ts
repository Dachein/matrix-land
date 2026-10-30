import { sha256 } from "@noble/hashes/sha2.js";
import { HttpError } from "../http.ts";
import type { Env, NamespaceRow, ObjectRow } from "../types.ts";
import type { StoredKnowledgeBinary } from "../objects/versions.ts";

export function allowedAudioDownloadUrl(raw: string, hostsValue: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(502, 'knowledge_download_host_denied'); }
  // Explicit storage hosts supplied by the provider; no wildcard, redirects, IPs or credentials.
  const hosts = hostsValue.split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
  if (raw.length > 8192 || url.hash || url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || url.hostname === "localhost" || /^[0-9.]+$/.test(url.hostname) || url.hostname.includes(":")
    || !hosts.includes(url.hostname.toLowerCase())) throw new HttpError(502, "knowledge_download_host_denied");
  return url.toString();
}

export async function storeRemoteAudio(env: Env, namespace: NamespaceRow, object: ObjectRow, rawUrl: string, mimeType: string, hostsValue: string, maximum = 512 * 1024 * 1024): Promise<StoredKnowledgeBinary & { mimeType: string }> {
  const response = await fetch(allowedAudioDownloadUrl(rawUrl, hostsValue), { redirect: "error", signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new HttpError(502, "knowledge_audio_download_failed");
  const responseType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (responseType && !responseType.startsWith('audio/') && responseType !== 'application/octet-stream') {
    await response.body.cancel(); throw new HttpError(502, 'knowledge_audio_content_type_invalid');
  }
  if (responseType?.startsWith("audio/")) mimeType = responseType;

  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body.cancel(); throw new HttpError(413, "knowledge_audio_too_large");
  }
  const versionId = `kov_${crypto.randomUUID()}`;
  const r2Key = `${namespace.r2_prefix}/objects/${object.id}/versions/${versionId}`;
  const upload = await env.KNOWLEDGE_OBJECTS.createMultipartUpload(r2Key, {
    httpMetadata: { contentType: mimeType }, customMetadata: { objectId: object.id, namespaceId: namespace.id, versionId }
  });
  const reader = response.body.getReader();
  const hasher = sha256.create();
  const partSize = 5 * 1024 * 1024;
  let buffer = new Uint8Array(partSize), filled = 0, size = 0;
  const parts: R2UploadedPart[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maximum) throw new HttpError(413, "knowledge_audio_too_large");
      hasher.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.length) {
        const count = Math.min(partSize - filled, chunk.value.length - offset);
        buffer.set(chunk.value.subarray(offset, offset + count), filled); filled += count; offset += count;
        if (filled === partSize) {
          parts.push(await upload.uploadPart(parts.length + 1, buffer));
          buffer = new Uint8Array(partSize); filled = 0;
        }
      }
    }
    if (!size) throw new HttpError(502, "knowledge_audio_empty");
    if (filled) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, filled)));
    await upload.complete(parts);
    return { versionId, r2Key, byteLength: size, mimeType, sha256: Array.from(hasher.digest(), value => value.toString(16).padStart(2, "0")).join("") };
  } catch (error) { await upload.abort().catch(() => {}); throw error; }
  finally { await reader.cancel(); }
}
