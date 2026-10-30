import { cloudflareApiResponse, cloudflareFetch, requireCloudflareAccountId } from "../cloudflare/client";
import { audit } from "../core/audit";
import { HttpError, type Env, type Principal } from "../core/types";
import { asRecord, bytesToBase64, readOptionalString, readString, requireText } from "../core/utils";
import { canReadApp, requireWritableApp } from "./queries";
import { provisionResourceTypes } from "../provisioning/cloudflareResources";
import type { AppsAppRow, AppsResourceRow } from "../db/rows";

type StorageInput = {
  appId?: unknown;
  content?: unknown;
  contentType?: unknown;
  encoding?: unknown;
  key?: unknown;
  limit?: unknown;
  metadata?: unknown;
  prefix?: unknown;
  value?: unknown;
};

type CloudflareKvKey = {
  expiration?: number;
  metadata?: unknown;
  name?: string;
};

type CloudflareR2Object = {
  etag?: string;
  key?: string;
  last_modified?: string;
  size?: number | string;
  uploaded?: string;
};

type StorageResourceType = "kv_namespace" | "r2_bucket";

const MAX_KV_ITEMS = 100;
const MAX_KV_VALUE_BYTES = 128_000;
const MAX_R2_OBJECTS = 100;
const MAX_R2_OBJECT_BYTES = 2_000_000;
const MAX_METADATA_BYTES = 4_000;

export async function listAppKvKeys(input: StorageInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const { resource } = await requireAppStorageResource(env, principal, appId, "kv_namespace", "read");
  const prefix = normalizeOptionalPrefix(input.prefix);
  const limit = boundedLimit(input.limit, MAX_KV_ITEMS);
  const accountId = requireCloudflareAccountId(env);
  const namespaceId = storageResourceId(resource, "kv_resource_not_ready");
  const params = new URLSearchParams({ limit: String(limit) });
  if (prefix) {
    params.set("prefix", prefix);
  }
  const rows = await cloudflareFetch<unknown>(env, `/accounts/${accountId}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/keys?${params}`);
  return {
    keys: collection<CloudflareKvKey>(rows, ["keys"]).map((item) => kvKeyFromCloudflare(appId, item)),
    resource: storageResourceSummary(resource)
  };
}

export async function getAppKvValue(input: StorageInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const key = normalizeStorageKey(input.key, "missing_kv_key", "invalid_kv_key", 512);
  const { resource } = await requireAppStorageResource(env, principal, appId, "kv_namespace", "read");
  const accountId = requireCloudflareAccountId(env);
  const namespaceId = storageResourceId(resource, "kv_resource_not_ready");
  const response = await cloudflareApiResponse(
    env,
    `/accounts/${accountId}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeStoragePath(key)}`,
    {},
    { allowNotFound: true }
  );
  if (response.status === 404) {
    throw new HttpError(404, "kv_key_not_found");
  }
  const value = await response.text();
  return {
    item: {
      appId,
      createdAt: "",
      createdBy: "",
      id: key,
      key,
      metadata: {},
      sizeBytes: new TextEncoder().encode(value).byteLength,
      updatedAt: "",
      updatedBy: "",
      value
    },
    resource: storageResourceSummary(resource)
  };
}

export async function putAppKvValue(input: StorageInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const { resource } = await requireAppStorageResource(env, principal, appId, "kv_namespace", "write");
  const key = normalizeStorageKey(input.key, "missing_kv_key", "invalid_kv_key", 512);
  const value = readString(input.value);
  const valueBytes = new TextEncoder().encode(value);
  if (valueBytes.byteLength === 0 || valueBytes.byteLength > MAX_KV_VALUE_BYTES) {
    throw new HttpError(400, "invalid_kv_value");
  }
  normalizeMetadata(input.metadata);
  const accountId = requireCloudflareAccountId(env);
  const namespaceId = storageResourceId(resource, "kv_resource_not_ready");
  await cloudflareApiResponse(env, `/accounts/${accountId}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeStoragePath(key)}`, {
    body: value,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    method: "PUT"
  });

  await audit(env.APPS_DB, principal, "updated app kv value via mcp", "apps_app", appId, {
    key,
    resourceId: readOptionalString(resource.resource_id),
    sizeBytes: valueBytes.byteLength
  });

  return getAppKvValue({ appId, key }, env, principal);
}

export async function deleteAppKvValue(input: StorageInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const key = normalizeStorageKey(input.key, "missing_kv_key", "invalid_kv_key", 512);
  const { resource } = await requireAppStorageResource(env, principal, appId, "kv_namespace", "write");
  const accountId = requireCloudflareAccountId(env);
  const namespaceId = storageResourceId(resource, "kv_resource_not_ready");
  await cloudflareApiResponse(env, `/accounts/${accountId}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeStoragePath(key)}`, {
    method: "DELETE"
  });
  await audit(env.APPS_DB, principal, "deleted app kv value via mcp", "apps_app", appId, {
    key,
    resourceId: readOptionalString(resource.resource_id)
  });
  return { deleted: true, key, resource: storageResourceSummary(resource) };
}

export async function listAppR2Objects(input: StorageInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const { resource } = await requireAppStorageResource(env, principal, appId, "r2_bucket", "read");
  const prefix = normalizeOptionalPrefix(input.prefix);
  const limit = boundedLimit(input.limit, MAX_R2_OBJECTS);
  const accountId = requireCloudflareAccountId(env);
  const bucketName = storageResourceName(resource, "r2_resource_not_ready");
  const params = new URLSearchParams({ per_page: String(limit) });
  if (prefix) {
    params.set("prefix", prefix);
  }
  const rows = await cloudflareFetch<unknown>(env, `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects?${params}`);
  return {
    objects: collection<CloudflareR2Object>(rows, ["objects"]).map((item) => r2ObjectFromCloudflare(appId, item)),
    resource: storageResourceSummary(resource)
  };
}

export async function getAppR2Object(input: StorageInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const key = normalizeStorageKey(input.key, "missing_r2_key", "invalid_r2_key", 768);
  const { resource } = await requireAppStorageResource(env, principal, appId, "r2_bucket", "read");
  const accountId = requireCloudflareAccountId(env);
  const bucketName = storageResourceName(resource, "r2_resource_not_ready");
  const response = await cloudflareApiResponse(
    env,
    `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeStoragePath(key)}`,
    {},
    { allowNotFound: true }
  );
  if (response.status === 404) {
    throw new HttpError(404, "r2_object_not_found");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || normalizeContentType(undefined, key);
  const etag = response.headers.get("etag")?.replace(/^"|"$/g, "") || await sha256Hex(bytes);
  const encoding = isTextContentType(contentType) ? "text" : "base64";
  return {
    object: {
      appId,
      content: encoding === "text" ? new TextDecoder().decode(bytes) : bytesToBase64(bytes),
      contentType,
      createdAt: "",
      createdBy: "",
      encoding,
      etag,
      id: key,
      key,
      sizeBytes: bytes.byteLength,
      updatedAt: response.headers.get("last-modified") || "",
      updatedBy: ""
    },
    resource: storageResourceSummary(resource)
  };
}

export async function putAppR2Object(input: StorageInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const { resource } = await requireAppStorageResource(env, principal, appId, "r2_bucket", "write");
  const key = normalizeStorageKey(input.key, "missing_r2_key", "invalid_r2_key", 768);
  const contentType = normalizeContentType(input.contentType, key);
  const body = decodeObjectContent(input.content, input.encoding);
  if (body.byteLength === 0 || body.byteLength > MAX_R2_OBJECT_BYTES) {
    throw new HttpError(400, "invalid_r2_object_content");
  }

  const accountId = requireCloudflareAccountId(env);
  const bucketName = storageResourceName(resource, "r2_resource_not_ready");
  const uploaded = await cloudflareFetch<unknown>(env, `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeStoragePath(key)}`, {
    body,
    headers: { "Content-Type": contentType },
    method: "PUT"
  });
  const uploadedRecord = asRecord(uploaded);
  const etag = readString(uploadedRecord.etag || await sha256Hex(body));

  await audit(env.APPS_DB, principal, "updated app r2 object via mcp", "apps_app", appId, {
    key,
    resourceId: readOptionalString(resource.resource_id),
    sizeBytes: body.byteLength
  });

  return {
    object: {
      appId,
      contentType,
      createdAt: readString(uploadedRecord.uploaded),
      createdBy: principal.sub,
      etag,
      id: key,
      key,
      sizeBytes: body.byteLength,
      updatedAt: readString(uploadedRecord.uploaded),
      updatedBy: principal.sub
    },
    resource: storageResourceSummary(resource)
  };
}

export async function deleteAppR2Object(input: StorageInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const key = normalizeStorageKey(input.key, "missing_r2_key", "invalid_r2_key", 768);
  const { resource } = await requireAppStorageResource(env, principal, appId, "r2_bucket", "write");
  const accountId = requireCloudflareAccountId(env);
  const bucketName = storageResourceName(resource, "r2_resource_not_ready");
  await cloudflareApiResponse(env, `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeStoragePath(key)}`, {
    method: "DELETE"
  });
  await audit(env.APPS_DB, principal, "deleted app r2 object via mcp", "apps_app", appId, {
    key,
    resourceId: readOptionalString(resource.resource_id)
  });
  return { deleted: true, key, resource: storageResourceSummary(resource) };
}

async function requireAppStorageResource(
  env: Env,
  principal: Principal,
  appId: string,
  type: StorageResourceType,
  mode: "read" | "write"
) {
  const app = mode === "write"
    ? await requireWritableApp(env.APPS_DB, principal, appId)
    : await requireReadableApp(env, principal, appId);
  if (mode === "write") {
    await provisionResourceTypes(env, app, [type], new Date().toISOString());
  }
  const resource = await env.APPS_DB
    .prepare(
      `
      SELECT *
      FROM apps_app_resources
      WHERE app_id = ?
        AND type = ?
        AND environment = 'prod'
      ORDER BY CASE status WHEN 'ready' THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1
      `
    )
    .bind(appId, type)
    .first<AppsResourceRow>();

  if (!resource) {
    throw new HttpError(409, type === "kv_namespace" ? "kv_resource_not_enabled" : "r2_resource_not_enabled");
  }
  if (resource.status !== "ready") {
    throw new HttpError(409, type === "kv_namespace" ? "kv_resource_not_ready" : "r2_resource_not_ready");
  }

  return { app, resource };
}

async function requireReadableApp(env: Env, principal: Principal, appId: string): Promise<AppsAppRow> {
  const row = await env.APPS_DB.prepare("SELECT * FROM apps_apps WHERE id = ? LIMIT 1").bind(appId).first<AppsAppRow>();
  if (!row || !canReadApp(row, principal)) {
    throw new HttpError(404, "apps_app_not_found");
  }
  return row;
}

function kvKeyFromCloudflare(appId: string, item: CloudflareKvKey) {
  const key = readString(item.name);
  return {
    appId,
    key,
    metadata: asRecord(item.metadata),
    sizeBytes: 0,
    updatedAt: item.expiration ? new Date(item.expiration * 1000).toISOString() : "",
    updatedBy: ""
  };
}

function r2ObjectFromCloudflare(appId: string, item: CloudflareR2Object) {
  const key = readString(item.key);
  return {
    appId,
    contentType: "",
    createdAt: readString(item.uploaded || item.last_modified),
    createdBy: "",
    etag: readString(item.etag),
    id: key,
    key,
    sizeBytes: Number(item.size) || 0,
    updatedAt: readString(item.last_modified || item.uploaded),
    updatedBy: ""
  };
}

function collection<T>(value: unknown, arrayKeys: string[]): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  const record = asRecord(value);
  for (const key of arrayKeys) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      return nested as T[];
    }
  }
  return [];
}

function storageResourceId(resource: AppsResourceRow, code: string) {
  const id = readString(resource.resource_id).trim();
  if (!id) {
    throw new HttpError(409, code);
  }
  return id;
}

function storageResourceName(resource: AppsResourceRow, code: string) {
  const name = readString(resource.resource_name).trim();
  if (!name) {
    throw new HttpError(409, code);
  }
  return name;
}

function encodeStoragePath(key: string) {
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function storageResourceSummary(resource: AppsResourceRow) {
  return {
    bindingName: readOptionalString(resource.binding_name),
    provider: resource.provider,
    resourceId: readOptionalString(resource.resource_id),
    resourceName: resource.resource_name,
    status: resource.status,
    type: resource.type
  };
}

function normalizeStorageKey(value: unknown, missingCode: string, invalidCode: string, maxLength: number) {
  const key = requireText(value, missingCode, maxLength);
  if (
    key.startsWith("/")
    || key.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(key)
    || key.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new HttpError(400, invalidCode);
  }
  return key;
}

function normalizeOptionalPrefix(value: unknown) {
  const prefix = readString(value).trim();
  if (!prefix) {
    return "";
  }
  return normalizeStorageKey(prefix, "missing_prefix", "invalid_prefix", 512);
}

function normalizeMetadata(value: unknown) {
  const metadata = asRecord(value);
  const text = JSON.stringify(metadata);
  if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES) {
    throw new HttpError(400, "metadata_too_large");
  }
  return text;
}

function boundedLimit(value: unknown, max: number) {
  const parsed = Number(readString(value) || "50");
  if (!Number.isFinite(parsed)) {
    return 50;
  }
  return Math.min(Math.max(Math.floor(parsed), 1), max);
}

function decodeObjectContent(value: unknown, encodingValue: unknown) {
  const encoding = normalizeEncoding(encodingValue);
  const content = readString(value);
  if (encoding === "base64") {
    try {
      const binary = atob(content);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    } catch {
      throw new HttpError(400, "invalid_base64_content");
    }
  }
  return new TextEncoder().encode(content);
}

function normalizeEncoding(value: unknown) {
  const encoding = readString(value).trim().toLowerCase();
  if (!encoding || encoding === "text") {
    return "text";
  }
  if (encoding === "base64") {
    return "base64";
  }
  throw new HttpError(400, "invalid_content_encoding");
}

function normalizeContentType(value: unknown, key: string) {
  const text = readString(value).trim().toLowerCase();
  if (text && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;\s*charset=[a-z0-9_-]+)?$/.test(text)) {
    return text.slice(0, 120);
  }
  return contentTypeForKey(key);
}

function contentTypeForKey(key: string) {
  const lower = key.toLowerCase();
  if (lower.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (lower.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
    return "application/javascript; charset=utf-8";
  }
  if (lower.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (lower.endsWith(".svg")) {
    return "image/svg+xml; charset=utf-8";
  }
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".csv")) {
    return "text/plain; charset=utf-8";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  return "application/octet-stream";
}

function isTextContentType(value: string) {
  const contentType = value.toLowerCase();
  return contentType.startsWith("text/")
    || contentType.includes("charset=")
    || contentType.startsWith("application/json")
    || contentType.startsWith("application/javascript")
    || contentType.startsWith("application/xml")
    || contentType.startsWith("image/svg+xml");
}

async function sha256Hex(bytes: Uint8Array) {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
