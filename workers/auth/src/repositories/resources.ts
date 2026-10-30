import type { Env, ResourceClient } from "../types.ts";
import { jsonStringList, normalizeAccessMode, normalizeStatus, optionalText, requireDb, requiredText, stringList } from "./values.ts";

// Resource registration and read models.
type ResourceClientRow = {
  access_mode: string;
  access_targets_json: string;
  allowed_scopes_json: string;
  audience: string;
  business_owner_user_id: string | null;
  collaborator_user_ids_json: string;
  id: string;
  name: string;
  publisher_user_id: string | null;
  status: string;
  system_role_policy_version: string;
};

type RegisterResourceInput = {
  accessMode?: string;
  accessTargets?: unknown;
  allowedScopes?: unknown;
  audience?: string;
  businessOwnerUserId?: string;
  collaboratorUserIds?: unknown;
  id?: string;
  name?: string;
  publisherUserId?: string;
  status?: string;
  systemRolePolicyVersion?: string;
};

export async function registerResourceClient(env: Env, input: RegisterResourceInput) {
  const db = requireDb(env);
  const resource: ResourceClient = {
    id: requiredText(input.id || `resource-${crypto.randomUUID()}`, "missing_resource_id", 180),
    name: optionalText(input.name, 240),
    status: normalizeStatus(input.status),
    audience: optionalText(input.audience, 600),
    accessMode: normalizeAccessMode(input.accessMode),
    accessTargets: stringList(input.accessTargets, 48, 180),
    collaboratorUserIds: stringList(input.collaboratorUserIds, 200, 180),
    allowedScopes: stringList(input.allowedScopes, 64, 160),
    publisherUserId: optionalText(input.publisherUserId, 160),
    businessOwnerUserId: optionalText(input.businessOwnerUserId, 160),
    systemRolePolicyVersion: optionalText(input.systemRolePolicyVersion, 180)
  };

  await db
    .prepare(
      `
      INSERT INTO auth_resource_clients (
        id,
        name,
        status,
        audience,
        access_mode,
        access_targets_json,
        collaborator_user_ids_json,
        allowed_scopes_json,
        publisher_user_id,
        business_owner_user_id,
        created_at,
        updated_at,
        system_role_policy_version
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        status = excluded.status,
        audience = excluded.audience,
        access_mode = excluded.access_mode,
        access_targets_json = CASE
          WHEN excluded.system_role_policy_version <> '' AND excluded.system_role_policy_version < auth_resource_clients.system_role_policy_version
          THEN auth_resource_clients.access_targets_json ELSE excluded.access_targets_json END,
        collaborator_user_ids_json = CASE
          WHEN auth_resource_clients.system_role_policy_version <> '' AND (excluded.system_role_policy_version = '' OR excluded.system_role_policy_version < auth_resource_clients.system_role_policy_version)
          THEN auth_resource_clients.collaborator_user_ids_json ELSE excluded.collaborator_user_ids_json END,
        allowed_scopes_json = excluded.allowed_scopes_json,
        publisher_user_id = CASE
          WHEN auth_resource_clients.system_role_policy_version <> '' AND (excluded.system_role_policy_version = '' OR excluded.system_role_policy_version < auth_resource_clients.system_role_policy_version)
          THEN auth_resource_clients.publisher_user_id ELSE excluded.publisher_user_id END,
        business_owner_user_id = CASE
          WHEN auth_resource_clients.system_role_policy_version <> '' AND (excluded.system_role_policy_version = '' OR excluded.system_role_policy_version < auth_resource_clients.system_role_policy_version)
          THEN auth_resource_clients.business_owner_user_id ELSE excluded.business_owner_user_id END,
        system_role_policy_version = CASE
          WHEN auth_resource_clients.system_role_policy_version <> '' AND (excluded.system_role_policy_version = '' OR excluded.system_role_policy_version < auth_resource_clients.system_role_policy_version)
          THEN auth_resource_clients.system_role_policy_version ELSE excluded.system_role_policy_version END,
        updated_at = CURRENT_TIMESTAMP
      `
    )
    .bind(
      resource.id,
      resource.name ?? "",
      resource.status ?? "draft",
      resource.audience ?? "",
      resource.accessMode ?? "public",
      JSON.stringify(resource.accessTargets ?? []),
      JSON.stringify(resource.collaboratorUserIds ?? []),
      JSON.stringify(resource.allowedScopes ?? []),
      resource.publisherUserId ?? null,
      resource.businessOwnerUserId ?? null,
      resource.systemRolePolicyVersion ?? ""
    )
    .run();

  return resource;
}

export async function readResourceClient(env: Env, resourceId: string): Promise<ResourceClient | undefined> {
  const db = requireDb(env);
  const row = await db
    .prepare(
      `
      SELECT
        id,
        name,
        status,
        audience,
        access_mode,
        access_targets_json,
        collaborator_user_ids_json,
        allowed_scopes_json,
        publisher_user_id,
        business_owner_user_id,
        system_role_policy_version
      FROM auth_resource_clients
      WHERE id = ?
      LIMIT 1
      `
    )
    .bind(resourceId)
    .first<ResourceClientRow>();

  return row ? resourceClientFromRow(row) : undefined;
}

function resourceClientFromRow(row: ResourceClientRow): ResourceClient {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    audience: row.audience,
    accessMode: normalizeAccessMode(row.access_mode),
    accessTargets: jsonStringList(row.access_targets_json),
    collaboratorUserIds: jsonStringList(row.collaborator_user_ids_json),
    allowedScopes: jsonStringList(row.allowed_scopes_json),
    publisherUserId: row.publisher_user_id ?? undefined,
    businessOwnerUserId: row.business_owner_user_id ?? undefined,
    systemRolePolicyVersion: row.system_role_policy_version || undefined
  };
}
