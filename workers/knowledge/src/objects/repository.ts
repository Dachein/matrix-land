import { HttpError } from "../http.ts";
import type { Env, NamespaceRow, ObjectRow, Principal, VersionRow } from "../types.ts";

// Read object metadata and versions. Callers enforce access before exposing rows.

export async function requireRootObjectForMutation(env: Env, object: ObjectRow) {
  const rootPath = object.path.split("/").filter(Boolean)[0] ?? "";
  if (!rootPath) {
    throw new HttpError(409, "knowledge_root_not_found");
  }
  const root = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT * FROM knowledge_objects
       WHERE namespace_id = ? AND parent_path = '' AND path = ?
         AND object_kind = 'folder' AND deleted_at IS NULL
       LIMIT 1`
    )
    .bind(object.namespace_id, rootPath)
    .first<ObjectRow>();
  if (!root) {
    throw new HttpError(409, "knowledge_root_folder_required");
  }
  return root;
}

export async function objectByPath(env: Env, namespaceId: string, path: string) {
  return env.KNOWLEDGE_DB
    .prepare("SELECT * FROM knowledge_objects WHERE namespace_id = ? AND path = ? AND deleted_at IS NULL LIMIT 1")
    .bind(namespaceId, path)
    .first<ObjectRow>();
}

export async function requireObject(env: Env, objectId: string) {
  const object = await env.KNOWLEDGE_DB.prepare("SELECT * FROM knowledge_objects WHERE id = ? AND deleted_at IS NULL").bind(objectId).first<ObjectRow>();
  if (!object) {
    throw new HttpError(404, "knowledge_object_not_found");
  }
  return object;
}

export async function requireDeletedObject(env: Env, objectId: string) {
  const object = await env.KNOWLEDGE_DB
    .prepare("SELECT * FROM knowledge_objects WHERE id = ? AND deleted_at IS NOT NULL")
    .bind(objectId)
    .first<ObjectRow>();
  if (!object) {
    throw new HttpError(404, "knowledge_object_not_found");
  }
  return object;
}

export async function requireNamespace(env: Env, namespaceId: string) {
  const namespace = await env.KNOWLEDGE_DB.prepare("SELECT * FROM knowledge_namespaces WHERE id = ?").bind(namespaceId).first<NamespaceRow>();
  if (!namespace) {
    throw new HttpError(404, "knowledge_namespace_not_found");
  }
  return namespace;
}

export async function requireNamespaceForPrincipal(env: Env, namespaceId: string, principal: Principal) {
  const namespace = await requireNamespace(env, namespaceId);
  if (namespace.org_id !== principal.orgId) {
    // Do not reveal the existence of resources in another organization.
    throw new HttpError(404, "knowledge_namespace_not_found");
  }
  return namespace;
}

export async function requireCurrentVersion(env: Env, object: ObjectRow) {
  if (!object.current_version_id) {
    throw new HttpError(404, "knowledge_version_not_found");
  }
  return requireVersion(env, object.current_version_id);
}

export async function requireVersion(env: Env, versionId: string) {
  const version = await env.KNOWLEDGE_DB.prepare("SELECT * FROM knowledge_object_versions WHERE id = ?").bind(versionId).first<VersionRow>();
  if (!version) {
    throw new HttpError(404, "knowledge_version_not_found");
  }
  return version;
}

export async function currentKnowledgeIngestionState(env: Env, object: ObjectRow) {
  if (!object.current_version_id) {
    return "pending";
  }
  const row = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT scan_status
       FROM knowledge_ingestion_states
       WHERE object_id = ? AND version_id = ?`
    )
    .bind(object.id, object.current_version_id)
    .first<{ scan_status: string }>();
  return row?.scan_status ?? "pending";
}
