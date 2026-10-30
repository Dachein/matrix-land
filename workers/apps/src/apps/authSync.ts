import type { AppsAppRow } from "../db/rows";
import { collaboratorUserIdsFromJson } from "../core/collaborators";
import { HttpError, type Env } from "../core/types";
import { normalizeAppCode, parseStringArray, readString } from "../core/utils";
import { runtimeUrls } from "../runtime/urls";
import { ensureManagedAppAuthSecrets, WORKSPACE_AUTH_APP_SECRET_NAME } from "./appAuthSecrets";

type AppsAppAuthSyncInput = {
  accessTargets?: string[];
  directoryReadScope?: "app" | "company";
  loginRequired: boolean;
  requestId?: string;
  sdkStatus?: "connected" | "pending";
  status?: "draft" | "listed";
  visibility: string;
};

type AuthSyncResult = {
  appId: string;
  skipped?: boolean;
  synced?: boolean;
};

const AUTH_CALLBACK_PATH = "/auth/workspace/callback";
const DEFAULT_AUTH_SYNC_TIMEOUT_MS = 8_000;
const MAX_AUTH_SYNC_ATTEMPTS = 2;

export async function syncAppsAppAuthClient(env: Env, app: AppsAppRow, input: AppsAppAuthSyncInput): Promise<AuthSyncResult> {
  if (!input.loginRequired) {
    return { appId: app.id, skipped: true };
  }

  const baseUrl = readString(env.AUTH_WORKER_URL || env.AUTH_ISSUER).trim();
  const serviceToken = readString(env.APPS_AUTH_SERVICE_TOKEN || env.AUTH_SERVICE_TOKEN).trim();
  if (!baseUrl || !serviceToken) {
    throw new HttpError(503, "auth_worker_not_configured");
  }

  const endpoint = authWorkerEndpoint(baseUrl);
  if (!endpoint) {
    throw new HttpError(503, "auth_worker_not_configured");
  }

  const appCode = normalizeAppCode(app.code || app.slug || app.id);
  const runtime = runtimeUrls(env, appCode);
  const configuredAccessTargets = normalizeAccessTargets(input.accessTargets ?? parseStringArray(app.access_targets_json));
  const collaboratorAccessTargets = collaboratorUserIdsFromJson(app.collaborator_user_ids_json)
    .map((userId) => `user:${userId}`);
  const status = input.status ?? "listed";
  // A pre-publish client must never inherit an org/public audience. Only the
  // owner (carried separately below) and explicit collaborators may preview it.
  const accessTargets = status === "draft"
    ? normalizeAccessTargets(collaboratorAccessTargets)
    : normalizeAccessTargets([...collaboratorAccessTargets, ...configuredAccessTargets]);
  const authSecret = await appAuthSecret(env, app);
  if (authSecret.required && !authSecret.value) {
    throw new HttpError(503, "workspace_auth_app_secret_not_configured");
  }
  const requestId = readString(input.requestId).trim();
  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
      ...(requestId ? { "x-request-id": requestId } : {})
    },
    body: JSON.stringify({
      accessMode: status === "draft" ? "targeted" : authAccessMode(input.visibility, configuredAccessTargets),
      accessTargets,
      businessOwnerUserId: app.owner_user_id,
      collaboratorUserIds: collaboratorUserIdsFromJson(app.collaborator_user_ids_json),
      directoryReadScope: input.directoryReadScope ?? normalizeDirectoryReadScope(app.directory_read_scope),
      callbackUrls: [`${runtime.productionUrl}${AUTH_CALLBACK_PATH}`],
      id: app.id,
      launchUrl: runtime.productionUrl,
      name: app.name,
      publisherUserId: app.owner_user_id,
      sdkStatus: input.sdkStatus ?? "connected",
      status,
      systemRolePolicyVersion: app.updated_at,
      ...(authSecret.value ? { appSecret: authSecret.value, appSecretName: authSecret.name } : {})
    })
  };

  await syncAuthAppWithDeadline(env, endpoint, requestInit, app.id, requestId);

  return { appId: app.id, synced: true };
}

async function appAuthSecret(env: Env, app: AppsAppRow) {
  const managed = await ensureManagedAppAuthSecrets(env, app);
  return {
    name: WORKSPACE_AUTH_APP_SECRET_NAME,
    required: true,
    value: managed.appSecret
  };
}

async function syncAuthAppWithDeadline(
  env: Env,
  endpoint: string,
  requestInit: RequestInit,
  appId: string,
  requestId: string
) {
  const deadline = Date.now() + authSyncTimeoutMs(env);

  for (let attempt = 1; attempt <= MAX_AUTH_SYNC_ATTEMPTS; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new HttpError(504, "auth_app_sync_timeout");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);

    try {
      const response = await fetch(endpoint, { ...requestInit, signal: controller.signal });
      if (response.ok) {
        return;
      }

      const upstreamRequestId = response.headers.get("x-request-id") ?? "";
      logAuthSyncFailure({ appId, attempt, requestId, status: response.status, upstreamRequestId });

      if (response.status === 401 || response.status === 403) {
        throw new HttpError(502, "auth_app_sync_unauthorized");
      }
      if (!isRetryableAuthStatus(response.status) || attempt === MAX_AUTH_SYNC_ATTEMPTS) {
        throw new HttpError(502, "auth_app_sync_unavailable");
      }
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      const timedOut = controller.signal.aborted || Date.now() >= deadline;
      logAuthSyncFailure({
        appId,
        attempt,
        error: timedOut ? "timeout" : "network_error",
        requestId
      });
      if (timedOut) {
        throw new HttpError(504, "auth_app_sync_timeout");
      }
      if (attempt === MAX_AUTH_SYNC_ATTEMPTS) {
        throw new HttpError(502, "auth_app_sync_unavailable");
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new HttpError(502, "auth_app_sync_unavailable");
}

function authSyncTimeoutMs(env: Env) {
  const configured = Number(env.AUTH_APP_SYNC_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_AUTH_SYNC_TIMEOUT_MS;
  }
  return Math.min(15_000, Math.max(20, Math.floor(configured)));
}

function isRetryableAuthStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function logAuthSyncFailure(input: {
  appId: string;
  attempt: number;
  error?: string;
  requestId: string;
  status?: number;
  upstreamRequestId?: string;
}) {
  console.warn(JSON.stringify({ event: "apps_auth_app_sync_failed", ...input }));
}

function authWorkerEndpoint(baseUrl: string) {
  try {
    return `${baseUrl.replace(/\/+$/, "")}/v1/admin/apps`;
  } catch {
    return "";
  }
}

function authAccessMode(visibility: string, accessTargets: string[]) {
  if (accessTargets.length > 0 || visibility === "private" || visibility === "team") {
    return "targeted";
  }
  return "public";
}

function normalizeAccessTargets(value: string[]) {
  return Array.from(new Set(value.map((item) => item.trim()).filter(Boolean))).slice(0, 400);
}

function normalizeDirectoryReadScope(value: unknown): "app" | "company" {
  return value === "company" ? "company" : "app";
}
