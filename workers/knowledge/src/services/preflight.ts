import { accessRoleForObject } from "../access/authorization.ts";
import { roleHasKnowledgeCapability } from "../access/policy.ts";
import { HttpError } from "../http.ts";
import { ensurePersonalNamespace } from "../namespaces/repository.ts";
import { objectByPath, requireCurrentVersion, requireNamespaceForPrincipal, requireObject, requireVersion } from "../objects/repository.ts";
import { objectJsonForPrincipal } from "../objects/representation.ts";
import { joinPath, normalizePath } from "../paths.ts";
import { HANDBOOK_FILE_NAME } from "../policy.ts";
import type { Env, NamespaceRow, ObjectRow, Principal } from "../types.ts";
import { readString } from "../values.ts";

export async function knowledgeServicePreflight(env: Env, principal: Principal, folderObjectId: string) {
  if (!folderObjectId) {
    throw new HttpError(400, "missing_knowledge_service_folder");
  }
  const folder = await requireObject(env, folderObjectId);
  const namespace = await requireNamespaceForPrincipal(env, folder.namespace_id, principal);
  if (folder.object_kind !== "folder") {
    throw new HttpError(400, "knowledge_service_target_not_folder");
  }
  if (folder.parent_path) {
    throw new HttpError(400, "knowledge_service_root_required");
  }
  if (!roleHasKnowledgeCapability(
    await accessRoleForObject(env, namespace, folder, principal),
    "manageService"
  )) {
    throw new HttpError(403, "knowledge_service_manage_denied");
  }
  const handbook = await objectByPath(env, namespace.id, joinPath(folder.path, HANDBOOK_FILE_NAME));
  let status: "ready" | "missing" | "invalid" = "missing";
  if (handbook) {
    if (handbook.object_kind !== "file" || handbook.file_name !== HANDBOOK_FILE_NAME || handbook.parent_path !== folder.path) {
      status = "invalid";
    } else if (handbook.current_version_id) {
      const version = await requireVersion(env, handbook.current_version_id).catch(() => undefined);
      if (version && await env.KNOWLEDGE_OBJECTS.head(version.r2_key)) {
        status = "ready";
      }
    }
  }
  return {
    status,
    ready: status === "ready",
    handbookObjectId: handbook?.object_kind === "file" ? handbook.id : undefined,
    folder: await objectJsonForPrincipal(env, folder, principal)
  };
}

export async function folderFromKnowledgeServicePublishBody(env: Env, principal: Principal, body: Record<string, unknown>) {
  const folderId = readString(body.folderObjectId).trim();
  if (folderId) {
    const object = await requireObject(env, folderId);
    await requireNamespaceForPrincipal(env, object.namespace_id, principal);
    if (object.object_kind !== "folder") {
      throw new HttpError(400, "knowledge_service_target_not_folder");
    }
    return object;
  }

  const folderPath = normalizePath(readString(body.folderPath ?? body.path));
  if (!folderPath) {
    throw new HttpError(400, "missing_knowledge_service_folder");
  }
  const namespace = await ensurePersonalNamespace(env, principal);
  const object = await objectByPath(env, namespace.id, folderPath);
  if (!object || object.object_kind !== "folder") {
    throw new HttpError(404, "knowledge_service_folder_not_found");
  }
  return object;
}

export async function requireExistingHandbookMarkdown(env: Env, namespace: NamespaceRow, folder: ObjectRow) {
  const handbook = await objectByPath(env, namespace.id, joinPath(folder.path, HANDBOOK_FILE_NAME));
  if (!handbook) {
    throw new HttpError(409, "knowledge_service_handbook_missing");
  }
  if (handbook.object_kind !== "file" || handbook.file_name !== HANDBOOK_FILE_NAME || handbook.parent_path !== folder.path) {
    throw new HttpError(409, "knowledge_service_handbook_invalid");
  }
  const version = await requireCurrentVersion(env, handbook).catch((error) => {
    if (error instanceof HttpError && error.code === "knowledge_version_not_found") {
      throw new HttpError(409, "knowledge_service_handbook_missing");
    }
    throw error;
  });
  if (!await env.KNOWLEDGE_OBJECTS.head(version.r2_key)) {
    throw new HttpError(409, "knowledge_service_handbook_missing");
  }
  return handbook;
}
