import { HttpError, json } from "../../../functions/api/http.ts";
import { readAuthWorkerSessionPrincipal } from "../../../functions/api/identity/authSessionClient.ts";
import type { MiniappContext, MiniappEnv } from "./services.ts";

const PREFIX = "miniapp-upload-staging/";
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const EXPIRES_MS = 24 * 60 * 60 * 1000;

type UploadManifest = {
  createdAt: number;
  expiresAt: number;
  fileName: string;
  mediaType: string;
  ownerId: string;
  parentObjectId?: string;
  sizeBytes: number;
  target: "knowledge" | "mate";
  mateId?: string;
};

type UploadServices = {
  knowledgeApi: { uploadFile(context: MiniappContext): Promise<unknown> };
  miniappFacadeApi: { proxyRuntime(context: MiniappContext, path: string): Promise<Response> };
};

type UploadDeps = { readOwner?: (context: MiniappContext) => Promise<string | undefined> };

export function createMiniappFileUploadApi(deps: UploadDeps = {}) {
  const readOwner = deps.readOwner ?? (async (context: MiniappContext) => {
    const principal = await readAuthWorkerSessionPrincipal(context.request, context.env);
    return principal?.userId;
  });
  async function owner(context: MiniappContext) {
    const userId = await readOwner(context);
    if (!userId) throw new HttpError(401, "not_authenticated");
    return userId;
  }
  return {
    async start(context: MiniappContext) {
      const ownerId = await owner(context);
      const bucket = stagingBucket(context.env);
      const body = await context.request.json().catch(() => undefined) as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "upload_metadata_invalid");
      const target = body.target;
      const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
      const mediaType = typeof body.mediaType === "string" ? body.mediaType.trim() : "";
      const sizeBytes = body.sizeBytes;
      const mateId = typeof body.mateId === "string" ? body.mateId.trim() : "";
      const parentObjectId = typeof body.parentObjectId === "string" ? body.parentObjectId.trim() : "";
      if ((target !== "mate" && target !== "knowledge") || !validFileName(fileName) || !Number.isInteger(sizeBytes) || (sizeBytes as number) < 1 || (sizeBytes as number) > MAX_FILE_BYTES) {
        throw new HttpError(400, "upload_metadata_invalid");
      }
      if (target === "mate" && (!mateId || mateId.length > 160 || /[\\/\u0000-\u001f]/.test(mateId))) throw new HttpError(400, "upload_mate_invalid");
      if (parentObjectId && (parentObjectId.length > 160 || /[\\/\u0000-\u001f]/.test(parentObjectId))) throw new HttpError(400, "upload_parent_invalid");
      const now = Date.now();
      const uploadId = crypto.randomUUID();
      const manifest: UploadManifest = {
        createdAt: now, expiresAt: now + EXPIRES_MS, fileName,
        mediaType: /^[\w.+-]+\/[\w.+-]+$/.test(mediaType) ? mediaType : "application/octet-stream",
        ownerId, sizeBytes: sizeBytes as number, target,
        ...(target === "mate" ? { mateId } : {}),
        ...(target === "knowledge" && parentObjectId ? { parentObjectId } : {})
      };
      await bucket.put(`${PREFIX}${uploadId}/manifest.json`, JSON.stringify(manifest), { customMetadata: { expiresAt: String(manifest.expiresAt) } });
      return { uploadId, chunkBytes: CHUNK_BYTES };
    },

    async putChunk(context: MiniappContext, uploadId: string, index: number) {
      const ownerId = await owner(context);
      const bucket = stagingBucket(context.env);
      const manifest = await loadManifest(bucket, uploadId, ownerId);
      const count = Math.ceil(manifest.sizeBytes / CHUNK_BYTES);
      if (!Number.isInteger(index) || index < 0 || index >= count) throw new HttpError(400, "upload_chunk_index_invalid");
      if (context.request.headers.get("content-type")?.split(";", 1)[0] !== "application/octet-stream") throw new HttpError(415, "upload_chunk_type_invalid");
      const expected = Math.min(CHUNK_BYTES, manifest.sizeBytes - index * CHUNK_BYTES);
      const declaredLength = Number(context.request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > expected) throw new HttpError(413, "upload_chunk_too_large");
      const bytes = await context.request.arrayBuffer();
      if (bytes.byteLength !== expected) throw new HttpError(400, "upload_chunk_size_invalid");
      await bucket.put(chunkKey(uploadId, index), bytes, { customMetadata: { expiresAt: String(manifest.expiresAt) } });
      return { received: true, index };
    },

    async complete(context: MiniappContext, uploadId: string, services: UploadServices): Promise<Response> {
      const ownerId = await owner(context);
      const bucket = stagingBucket(context.env);
      const manifest = await loadManifest(bucket, uploadId, ownerId);
      const count = Math.ceil(manifest.sizeBytes / CHUNK_BYTES);
      const parts: ArrayBuffer[] = [];
      for (let index = 0; index < count; index += 1) {
        const object = await bucket.get(chunkKey(uploadId, index));
        if (!object) throw new HttpError(409, "upload_chunk_missing");
        const bytes = await object.arrayBuffer();
        if (bytes.byteLength !== Math.min(CHUNK_BYTES, manifest.sizeBytes - index * CHUNK_BYTES)) throw new HttpError(409, "upload_chunk_size_invalid");
        parts.push(bytes);
      }
      const form = new FormData();
      form.set("file", new File(parts, manifest.fileName, { type: manifest.mediaType }));
      if (manifest.parentObjectId) form.set("parentObjectId", manifest.parentObjectId);
      const headers = new Headers();
      const cookie = context.request.headers.get("cookie");
      if (cookie) headers.set("cookie", cookie);
      const authorization = context.request.headers.get("authorization");
      if (authorization) headers.set("authorization", authorization);
      const uploadContext = { ...context, request: new Request(context.request.url, { method: "POST", headers, body: form }) } as MiniappContext;
      const response = manifest.target === "knowledge"
        ? json(await services.knowledgeApi.uploadFile(uploadContext), { status: 201 })
        : await services.miniappFacadeApi.proxyRuntime(uploadContext, `/v1/mates/${encodeURIComponent(manifest.mateId!)}/workspace-attachments`);
      if (response.ok) {
        await bucket.delete([`${PREFIX}${uploadId}/manifest.json`, ...Array.from({ length: count }, (_, index) => chunkKey(uploadId, index))]);
      }
      return response;
    }
  };
}

export async function cleanupStagedUploads(bucket: R2Bucket | undefined) {
  if (!bucket) return;
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const listed = await bucket.list({ prefix: PREFIX, limit: 1000, include: ["customMetadata"], ...(cursor ? { cursor } : {}) } as R2ListOptions);
    const expired = listed.objects.filter((object) => Number(object.customMetadata?.expiresAt) < Date.now()).map((object) => object.key);
    if (expired.length) await bucket.delete(expired);
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
}

function stagingBucket(env: MiniappEnv) {
  if (!env.UPLOAD_STAGING) throw new HttpError(503, "upload_staging_not_configured");
  return env.UPLOAD_STAGING;
}

async function loadManifest(bucket: R2Bucket, uploadId: string, ownerId: string): Promise<UploadManifest> {
  const object = await bucket.get(`${PREFIX}${uploadId}/manifest.json`);
  if (!object) throw new HttpError(404, "upload_not_found");
  const manifest = await object.json<UploadManifest>();
  if (manifest.ownerId !== ownerId) throw new HttpError(404, "upload_not_found");
  if (manifest.expiresAt <= Date.now()) throw new HttpError(410, "upload_expired");
  return manifest;
}

function chunkKey(uploadId: string, index: number) {
  return `${PREFIX}${uploadId}/chunk-${index}`;
}

function validFileName(value: string) {
  return Boolean(value) && value.length <= 255 && value !== "." && value !== ".." && !/[\\/\u0000-\u001f]/.test(value);
}
