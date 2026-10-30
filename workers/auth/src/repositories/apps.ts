import { type AppAccessResult, type AppClient, type Env, type WorkspaceUser, HttpError } from "../types.ts";
import { hashLaunchCode, randomOpaqueCode, sha256Hex } from "./crypto.ts";
import { readAuthUserById } from "./users/reads.ts";
import { normalizeAuthUser } from "./users/values.ts";
import { upsertAuthUserSnapshot } from "./users/writes.ts";
import {
  jsonStringList,
  normalizeAccessMode,
  normalizeDirectoryReadScope,
  normalizeSdkStatus,
  normalizeStatus,
  optionalText,
  readJsonRecord,
  requireDb,
  requiredText,
  stringList
} from "./values.ts";

// App registration, one-use launch codes and app login records.
type AppClientRow = {
  access_mode: string;
  access_targets_json: string;
  app_secret_hash?: string;
  app_secret_name?: string;
  business_owner_user_id: string | null;
  collaborator_user_ids_json: string;
  callback_urls_json: string;
  directory_read_scope: string;
  id: string;
  launch_url: string | null;
  name: string;
  publisher_user_id: string | null;
  sdk_status: string;
  status: string;
  system_role_policy_version: string;
};

type AppLaunchCodeRow = {
  app_id: string;
  callback_url: string;
  code_hash: string;
  consumed_at: string | null;
  expires_at: string;
  redirect_url: string | null;
  request_id: string | null;
  user_id: string;
  user_json: string;
};

type RegisterAppInput = {
  accessMode?: string;
  accessTargets?: unknown;
  appSecret?: string;
  appSecretHash?: string;
  appSecretName?: string;
  businessOwnerUserId?: string;
  callbackUrls?: unknown;
  collaboratorUserIds?: unknown;
  directoryReadScope?: string;
  id?: string;
  launchUrl?: string;
  name?: string;
  publisherUserId?: string;
  sdkStatus?: string;
  status?: string;
  systemRolePolicyVersion?: string;
};

type AppLaunchCodeInput = {
  app: AppClient;
  callbackUrl: string;
  expiresAt: string;
  redirectUrl?: string;
  requestId?: string;
  user: WorkspaceUser;
};

export async function readAppClient(env: Env, appId: string): Promise<AppClient | undefined> {
  if (!env.AUTH_DB) {
    return undefined;
  }

  const row = await env.AUTH_DB
    .prepare(
      `
      SELECT
        id,
        name,
        status,
        sdk_status,
        access_mode,
        access_targets_json,
        collaborator_user_ids_json,
        publisher_user_id,
        business_owner_user_id,
        callback_urls_json,
        directory_read_scope,
        launch_url,
        app_secret_name,
        system_role_policy_version
      FROM auth_app_clients
      WHERE id = ?
      LIMIT 1
      `
    )
    .bind(appId)
    .first<AppClientRow>();

  return row ? appClientFromRow(row) : undefined;
}

export async function registerAppClient(env: Env, input: RegisterAppInput) {
  const db = requireDb(env);
  const appId = requiredText(input.id || `app-${crypto.randomUUID()}`, "missing_app_id", 160);
  const plainAppSecret = optionalText(input.appSecret, 4096);
  if (plainAppSecret && plainAppSecret.length < 32) {
    throw new HttpError(400, "weak_app_client_secret");
  }
  const suppliedSecretHash = optionalText(input.appSecretHash, 240)
    ?? (plainAppSecret ? await hashAppSecret(plainAppSecret) : undefined);
  const existingSecretHash = await readAppClientSecretHash(env, appId);
  const appSecretHash = suppliedSecretHash ?? existingSecretHash;
  if (!appSecretHash) {
    throw new HttpError(400, "app_client_secret_required");
  }
  const app: AppClient = {
    id: appId,
    name: optionalText(input.name, 240),
    status: normalizeStatus(input.status),
    sdkStatus: normalizeSdkStatus(input.sdkStatus),
    accessMode: normalizeAccessMode(input.accessMode),
    accessTargets: stringList(input.accessTargets, 400, 180),
    collaboratorUserIds: stringList(input.collaboratorUserIds, 200, 180),
    directoryReadScope: normalizeDirectoryReadScope(input.directoryReadScope),
    publisherUserId: optionalText(input.publisherUserId, 160),
    businessOwnerUserId: optionalText(input.businessOwnerUserId, 160),
    callbackUrls: stringList(input.callbackUrls, 12, 600),
    appSecretName: optionalText(input.appSecretName, 180),
    launchUrl: optionalText(input.launchUrl, 600),
    systemRolePolicyVersion: optionalText(input.systemRolePolicyVersion, 180)
  };

  await db
    .prepare(
      `
      INSERT INTO auth_app_clients (
        id,
        name,
        status,
        sdk_status,
        access_mode,
        access_targets_json,
        collaborator_user_ids_json,
        publisher_user_id,
        business_owner_user_id,
        callback_urls_json,
        directory_read_scope,
        launch_url,
        app_secret_hash,
        app_secret_name,
        created_at,
        updated_at,
        system_role_policy_version
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        status = excluded.status,
        sdk_status = excluded.sdk_status,
        access_mode = excluded.access_mode,
        access_targets_json = CASE
          WHEN excluded.system_role_policy_version <> '' AND excluded.system_role_policy_version < auth_app_clients.system_role_policy_version
          THEN auth_app_clients.access_targets_json ELSE excluded.access_targets_json END,
        collaborator_user_ids_json = CASE
          WHEN auth_app_clients.system_role_policy_version <> '' AND (excluded.system_role_policy_version = '' OR excluded.system_role_policy_version < auth_app_clients.system_role_policy_version)
          THEN auth_app_clients.collaborator_user_ids_json ELSE excluded.collaborator_user_ids_json END,
        publisher_user_id = CASE
          WHEN auth_app_clients.system_role_policy_version <> '' AND (excluded.system_role_policy_version = '' OR excluded.system_role_policy_version < auth_app_clients.system_role_policy_version)
          THEN auth_app_clients.publisher_user_id ELSE excluded.publisher_user_id END,
        business_owner_user_id = CASE
          WHEN auth_app_clients.system_role_policy_version <> '' AND (excluded.system_role_policy_version = '' OR excluded.system_role_policy_version < auth_app_clients.system_role_policy_version)
          THEN auth_app_clients.business_owner_user_id ELSE excluded.business_owner_user_id END,
        callback_urls_json = excluded.callback_urls_json,
        directory_read_scope = CASE
          WHEN ? = 1 THEN excluded.directory_read_scope
          ELSE auth_app_clients.directory_read_scope
        END,
        launch_url = excluded.launch_url,
        app_secret_hash = CASE WHEN excluded.app_secret_hash != '' THEN excluded.app_secret_hash ELSE auth_app_clients.app_secret_hash END,
        app_secret_name = CASE WHEN excluded.app_secret_name != '' THEN excluded.app_secret_name ELSE auth_app_clients.app_secret_name END,
        system_role_policy_version = CASE
          WHEN auth_app_clients.system_role_policy_version <> '' AND (excluded.system_role_policy_version = '' OR excluded.system_role_policy_version < auth_app_clients.system_role_policy_version)
          THEN auth_app_clients.system_role_policy_version ELSE excluded.system_role_policy_version END,
        updated_at = CURRENT_TIMESTAMP
      `
    )
    .bind(
      app.id,
      app.name ?? "",
      app.status ?? "draft",
      app.sdkStatus ?? "pending",
      app.accessMode ?? "public",
      JSON.stringify(app.accessTargets ?? []),
      JSON.stringify(app.collaboratorUserIds ?? []),
      app.publisherUserId ?? null,
      app.businessOwnerUserId ?? null,
      JSON.stringify(app.callbackUrls ?? []),
      app.directoryReadScope ?? "app",
      app.launchUrl ?? null,
      appSecretHash ?? "",
      app.appSecretName ?? "",
      app.systemRolePolicyVersion ?? "",
      input.directoryReadScope === undefined ? 0 : 1
    )
    .run();

  return await readAppClient(env, app.id) ?? app;
}

export async function readAppClientSecretHash(env: Env, appId: string) {
  const db = requireDb(env);
  const row = await db
    .prepare("SELECT app_secret_hash AS appSecretHash FROM auth_app_clients WHERE id = ? LIMIT 1")
    .bind(appId)
    .first<{ appSecretHash: string }>();
  return optionalText(row?.appSecretHash, 240);
}

export async function hashAppSecret(secret: string) {
  return `sha256:${await sha256Hex(secret)}`;
}

export async function createAppLaunchCode(env: Env, input: AppLaunchCodeInput) {
  const db = requireDb(env);
  const code = randomOpaqueCode("fac");
  const codeHash = await hashLaunchCode(code);
  const user = normalizeAuthUser(input.user);

  if (!input.app.id) {
    throw new HttpError(400, "missing_app_id");
  }

  if (!user.id) {
    throw new HttpError(400, "missing_user_id");
  }

  await db
    .prepare(
      `
      INSERT INTO auth_app_launch_codes (
        code_hash,
        app_id,
        user_id,
        user_json,
        callback_url,
        redirect_url,
        request_id,
        expires_at,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `
    )
    .bind(
      codeHash,
      input.app.id,
      user.id,
      JSON.stringify(user),
      input.callbackUrl,
      input.redirectUrl ?? null,
      input.requestId ?? null,
      input.expiresAt
    )
    .run();

  return {
    code,
    appId: input.app.id,
    expiresAt: input.expiresAt,
    redirectUrl: input.redirectUrl,
    user
  };
}

export async function consumeAppLaunchCode(env: Env, code: string, appId?: string) {
  const db = requireDb(env);
  const codeHash = await hashLaunchCode(code);
  const row = await db
    .prepare(
      `
      SELECT code_hash, app_id, user_id, user_json, callback_url, redirect_url, request_id, expires_at, consumed_at
      FROM auth_app_launch_codes
      WHERE code_hash = ?
      LIMIT 1
      `
    )
    .bind(codeHash)
    .first<AppLaunchCodeRow>();

  if (!row) {
    throw new HttpError(401, "invalid_launch_code");
  }

  if (appId && row.app_id !== appId) {
    throw new HttpError(401, "launch_code_app_mismatch");
  }

  if (row.consumed_at) {
    throw new HttpError(409, "launch_code_already_consumed");
  }

  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new HttpError(401, "launch_code_expired");
  }

  const consumed = await db
    .prepare("UPDATE auth_app_launch_codes SET consumed_at = CURRENT_TIMESTAMP WHERE code_hash = ? AND consumed_at IS NULL")
    .bind(codeHash)
    .run();
  if (typeof consumed.meta?.changes === "number" && consumed.meta.changes === 0) {
    throw new HttpError(409, "launch_code_already_consumed");
  }

  return {
    appId: row.app_id,
    callbackUrl: row.callback_url,
    expiresAt: Math.floor(Date.parse(row.expires_at) / 1000),
    redirectUrl: row.redirect_url ?? undefined,
    requestId: row.request_id ?? undefined,
    user: normalizeAuthUser(readJsonRecord(row.user_json) as WorkspaceUser)
  };
}

export async function recordAppUserLogin(env: Env, input: {
  access: AppAccessResult;
  app: AppClient;
  requestId?: string;
  user: WorkspaceUser;
}) {
  if (!env.AUTH_DB || !input.user.id) {
    return { stored: false };
  }

  const db = env.AUTH_DB;
  const canonical = await readAuthUserById(env, input.user.id);
  const user = canonical?.source === "moka" ? canonical : await upsertAuthUserSnapshot(env, input.user);

  await db
    .prepare(
      `
      INSERT INTO auth_app_users (
        app_id,
        user_id,
        email,
        job_title,
        name,
        role,
        department_id,
        department_name,
        team_id,
        team_name,
        first_login_at,
        last_login_at,
        login_count,
        last_decision,
        last_decision_reason,
        status,
        request_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, ?, ?, 'active', ?)
      ON CONFLICT(app_id, user_id) DO UPDATE SET
        email = excluded.email,
        job_title = excluded.job_title,
        name = excluded.name,
        role = excluded.role,
        department_id = excluded.department_id,
        department_name = excluded.department_name,
        team_id = excluded.team_id,
        team_name = excluded.team_name,
        last_login_at = CURRENT_TIMESTAMP,
        login_count = auth_app_users.login_count + 1,
        last_decision = excluded.last_decision,
        last_decision_reason = excluded.last_decision_reason,
        status = 'active',
        request_id = excluded.request_id
      `
    )
    .bind(
      input.app.id,
      user.id,
      user.email ?? "",
      user.jobTitle ?? "",
      user.name ?? "",
      user.role ?? "",
      user.departmentId ?? null,
      user.department ?? "",
      user.teamId ?? null,
      user.team ?? "",
      input.access.decision,
      input.access.reason,
      input.requestId ?? null
    )
    .run();

  return { stored: true };
}

export async function listAppUsers(env: Env, appId: string, limit = 100) {
  const db = requireDb(env);
  const rows = await db
    .prepare(
      `
      SELECT
        app_id AS appId,
        user_id AS userId,
        email,
        job_title AS jobTitle,
        name,
        role,
        department_id AS departmentId,
        department_name AS department,
        team_id AS teamId,
        team_name AS team,
        first_login_at AS firstLoginAt,
        last_login_at AS lastLoginAt,
        login_count AS loginCount,
        last_decision AS lastDecision,
        last_decision_reason AS lastDecisionReason,
        status
      FROM auth_app_users
      WHERE app_id = ?
      ORDER BY last_login_at DESC
      LIMIT ?
      `
    )
    .bind(requiredText(appId, "missing_app_id", 160), Math.min(Math.max(limit, 1), 500))
    .all<Record<string, unknown>>();

  return rows.results ?? [];
}

function appClientFromRow(row: AppClientRow): AppClient {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    sdkStatus: row.sdk_status,
    accessMode: normalizeAccessMode(row.access_mode),
    accessTargets: jsonStringList(row.access_targets_json),
    collaboratorUserIds: jsonStringList(row.collaborator_user_ids_json),
    publisherUserId: row.publisher_user_id ?? undefined,
    businessOwnerUserId: row.business_owner_user_id ?? undefined,
    callbackUrls: jsonStringList(row.callback_urls_json),
    directoryReadScope: normalizeDirectoryReadScope(row.directory_read_scope),
    appSecretName: row.app_secret_name || undefined,
    launchUrl: row.launch_url ?? undefined,
    systemRolePolicyVersion: row.system_role_policy_version || undefined
  };
}
