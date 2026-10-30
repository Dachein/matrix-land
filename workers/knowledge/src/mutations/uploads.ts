import { storeRemoteAudio } from './remoteAudioDownloads.ts';
import { existingMutationCommand } from './commands.ts';
import { requireRootObjectForMutation } from '../objects/repository.ts';
import { processKnowledgeDiffOutboxAfterMutation } from "../audit/diffs.ts";
import { HttpError } from "../http.ts";
import { uploadZipArchive } from "../imports/zip/import.ts";
import { dispatchKnowledgeIndexOutboxAfterMutation } from "../indexing/outbox.ts";
import { knowledgeV2Flags } from "../knowledge-v2-flags.ts";
import { assertObjectMutationAllowed } from "../objects/access.ts";
import { contentKindFromMime, contentTypeFromName, sha256Hex } from "../objects/content.ts";
import { objectByPath, requireObject, requireVersion } from "../objects/repository.ts";
import { cleanupEmptyFileObject, persistObjectVersion } from "../objects/versions.ts";
import { createFileObject } from "../objects/writes.ts";
import { joinPath, normalizePath, parentPathFromPath, validateFileName } from "../paths.ts";
import { effectiveKnowledgePolicy } from "../policy.ts";
import { markKnowledgeServicesStaleForPath } from "../services/invalidation.ts";
import type { Env, KnowledgeMutationContext, NamespaceRow, ObjectRow, Principal, VersionRow } from "../types.ts";
import { readString } from "../values.ts";
import { mutationContextFromRequest } from "./context.ts";

export async function uploadFile(
  form: FormData,
  env: Env,
  namespace: NamespaceRow,
  principal: Principal,
  mutation: KnowledgeMutationContext
) {
  if (form.has('sourceUrl')) return uploadRemoteAudio(form, env, namespace, principal, mutation);
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "missing_file");
  }
  const parentPath = normalizePath(readString(form.get("parentPath")));
  const requestedPath = readString(form.get("path"));
  const fileName = validateFileName(requestedPath ? requestedPath.split("/").filter(Boolean).at(-1) ?? file.name : file.name);
  const path = normalizePath(requestedPath || joinPath(parentPath, fileName));
  const finalParentPath = parentPathFromPath(path);
  const finalFileName = path.split("/").at(-1) || fileName;
  const extractZip = shouldExtractZip(file, finalFileName, form);
  assertKnowledgeUploadSize(env, file, extractZip);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new HttpError(400, "empty_file");
  }
  if (extractZip) {
    return uploadZipArchive(
      env,
      namespace,
      principal,
      finalParentPath,
      finalFileName,
      bytes,
      { ...mutation, operation: "zip_import", sourceChannel: "zip" }
    );
  }
  return upsertFileBytes(
    env,
    namespace,
    principal,
    finalParentPath,
    path,
    finalFileName,
    bytes,
    file.type || contentTypeFromName(finalFileName),
    mutation
  );
}

async function uploadRemoteAudio(form: FormData, env: Env, namespace: NamespaceRow, principal: Principal, mutation: KnowledgeMutationContext) {
  if (form.has('file')) throw new HttpError(400, 'knowledge_upload_content_conflict');
  const sourceUrl = readString(form.get('sourceUrl'));
  const fileName = validateFileName(readString(form.get('fileName')));
  const mimeType = readString(form.get('mimeType')) || contentTypeFromName(fileName);
  if (!/^audio\/[a-z0-9.+-]+$/i.test(mimeType)) throw new HttpError(400, 'knowledge_remote_audio_required');
  if (!env.KNOWLEDGE_AUDIO_DOWNLOAD_HOSTS) throw new HttpError(503, 'knowledge_audio_import_not_configured');
  const parentPath = normalizePath(readString(form.get('parentPath'))), path = joinPath(parentPath, fileName);
  const requestHash = await sha256Hex(new TextEncoder().encode(JSON.stringify({ sourceUrl, fileName, mimeType, parentPath, userId: principal.sub, idempotencyKey: mutation.idempotencyKey })));
  const existing = await objectByPath(env, namespace.id, path);
  if (existing) {
    await assertObjectMutationAllowed(env, namespace, existing, principal, 'content');
    if (JSON.parse(existing.metadata_json || '{}').remoteAudioRequestHash !== requestHash)
      throw new HttpError(409, 'knowledge_audio_file_already_exists');
    if (existing.current_version_id) {
      const root = await requireRootObjectForMutation(env, existing);
      const replay = knowledgeV2Flags(env).mutationSpine && await existingMutationCommand(env,
        `${principal.orgId}:${principal.sub}:${root.id}:create`, mutation.idempotencyKey);
      if (!replay || !replay.version_after_id || replay.status !== 'committed') throw new HttpError(409, 'knowledge_audio_file_already_exists');
      const version = await requireVersion(env, replay.version_after_id);
      if (version.object_id !== existing.id) throw new HttpError(409, 'knowledge_audio_file_already_exists');
      return { object: existing, version };
    }
  }
  const object = existing || await createFileObject(env, namespace.id, principal, parentPath, path, fileName, mimeType, 'binary');
  if (!existing) await env.KNOWLEDGE_DB.prepare('UPDATE knowledge_objects SET metadata_json = ? WHERE id = ?')
    .bind(JSON.stringify({ remoteAudioRequestHash: requestHash }), object.id).run();
  let stored: Awaited<ReturnType<typeof storeRemoteAudio>> | undefined;
  try {
    stored = await storeRemoteAudio(env, namespace, object, sourceUrl, mimeType, env.KNOWLEDGE_AUDIO_DOWNLOAD_HOSTS,
      effectiveKnowledgePolicy(env).limits.audioFileBytes);
    const version = await persistObjectVersion(env, namespace, object, principal, stored, stored.mimeType, 'binary', stored.sha256, mutation);
    if (version.r2_key !== stored.r2Key) await env.KNOWLEDGE_OBJECTS.delete(stored.r2Key);
    if (knowledgeV2Flags(env).mutationSpine) await dispatchKnowledgeIndexOutboxAfterMutation(env);
    else await markKnowledgeServicesStaleForPath(env, namespace.id, path);
    return { object: await requireObject(env, object.id), version };
  } catch (error) {
    if (stored) {
      const committed = await env.KNOWLEDGE_DB.prepare('SELECT id FROM knowledge_object_versions WHERE r2_key = ?').bind(stored.r2Key).first();
      if (!committed) await env.KNOWLEDGE_OBJECTS.delete(stored.r2Key);
    }
    if (!existing) await cleanupEmptyFileObject(env, object.id, error); throw error;
  }
}

async function upsertFileBytes(
  env: Env,
  namespace: NamespaceRow,
  principal: Principal,
  parentPath: string,
  path: string,
  fileName: string,
  bytes: Uint8Array,
  rawMimeType: string,
  mutation: KnowledgeMutationContext
) {
  const sha256 = await sha256Hex(bytes);
  const mimeType = rawMimeType || contentTypeFromName(fileName);
  const contentKind = contentKindFromMime(mimeType, fileName);
  const existing = await objectByPath(env, namespace.id, path);
  if (existing) {
    await assertObjectMutationAllowed(env, namespace, existing, principal, "content");
  }
  const object = existing ?? await createFileObject(env, namespace.id, principal, parentPath, path, fileName, mimeType, contentKind);
  if (object.object_kind !== "file") {
    throw new HttpError(409, "path_is_folder");
  }
  let version: VersionRow;
  try {
    version = await persistObjectVersion(
      env,
      namespace,
      object,
      principal,
      bytes,
      mimeType,
      contentKind,
      sha256,
      mutation
    );
  } catch (error) {
    if (!existing) {
      await cleanupEmptyFileObject(env, object.id, error);
    }
    throw error;
  }
  if (knowledgeV2Flags(env).mutationSpine) {
    await processKnowledgeDiffOutboxAfterMutation(env, version.id);
    await dispatchKnowledgeIndexOutboxAfterMutation(env);
  } else {
    await markKnowledgeServicesStaleForPath(env, namespace.id, path);
  }
  return {
    object: await requireObject(env, object.id),
    version
  };
}

export async function uploadNewVersion(
  request: Request,
  env: Env,
  namespace: NamespaceRow,
  object: ObjectRow,
  principal: Principal,
  requestId: string
) {
  if (object.object_kind !== "file") {
    throw new HttpError(400, "folder_not_versionable");
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "missing_file");
  }
  assertKnowledgeUploadSize(env, file, false);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new HttpError(400, "empty_file");
  }
  const sha256 = await sha256Hex(bytes);
  const mimeType = file.type || contentTypeFromName(object.file_name);
  const contentKind = contentKindFromMime(mimeType, object.file_name);
  const mutation = mutationContextFromRequest(
    request,
    requestId,
    "update",
    readString(form.get("expectedCurrentVersionId") ?? form.get("expected_current_version_id"))
  );
  const version = await persistObjectVersion(env, namespace, object, principal, bytes, mimeType, contentKind, sha256, mutation);
  if (knowledgeV2Flags(env).mutationSpine) {
    await processKnowledgeDiffOutboxAfterMutation(env, version.id);
    await dispatchKnowledgeIndexOutboxAfterMutation(env);
  } else {
    await markKnowledgeServicesStaleForPath(env, namespace.id, object.path);
  }
  return {
    object: await requireObject(env, object.id),
    version
  };
}

function assertKnowledgeUploadSize(env: Env, file: File, extractZip: boolean) {
  if (file.size === 0) {
    throw new HttpError(400, "empty_file");
  }
  const policy = effectiveKnowledgePolicy(env);
  const maxBytes = extractZip ? policy.limits.zipBytes : policy.limits.fileBytes;
  if (file.size > maxBytes) {
    throw new HttpError(413, extractZip ? "knowledge_zip_upload_too_large" : "knowledge_file_too_large");
  }
}

function shouldExtractZip(file: File, fileName: string, form: FormData) {
  const explicit = readString(form.get("extractZip") ?? form.get("extract")).trim().toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "no") {
    return false;
  }
  return fileName.toLowerCase().endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}
