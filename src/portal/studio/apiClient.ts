import type { PortalCatalog } from "../../shared/types";
import { appsScopes } from "./constants";

const APPS_REQUEST_TIMEOUT_MS = 15_000;
const APPS_CREATION_TIMEOUT_MS = 70_000;
const KNOWN_APPS_API_ERROR_CODES = new Set([
  "apps_owner_target_inactive", "apps_owner_transfer_already_pending", "apps_ownership_sync_pending",
  "apps_owner_transfer_not_pending", "apps_owner_transfer_owner_changed", "apps_owner_transfer_expired",
  "auth_app_sync_timeout",
  "auth_app_sync_unauthorized",
  "auth_app_sync_unavailable",
  "auth_worker_not_configured",
  "workspace_auth_app_secret_not_configured",
  "apps_app_code_immutable",
  "apps_app_type_immutable",
  "mate_code_immutable",
  "default_mate_email_conflict",
  "default_mate_user_email_invalid",
  "default_mate_avatar_invalid",
  "default_mate_cannot_archive",
  "mate_email_conflict",
  "mate_avatar_invalid",
  "mate_avatar_too_large",
  "mate_identity_conflict",
  "mate_work_email_invalid",
  "apps_worker_timeout",
  "apps_worker_unavailable"
]);

export class AppsApiError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly status: number;

  constructor(status: number, code: string, requestId = "") {
    super(code);
    this.code = code;
    this.requestId = requestId;
    this.status = status;
  }
}

export async function appsApiFetch<T>(path: string, catalog: PortalCatalog, init: RequestInit = {}): Promise<T> {
  const response = await appsApiRequest(path, catalog, init);
  return response.json() as Promise<T>;
}

export async function appsApiRequest(path: string, catalog: PortalCatalog, init: RequestInit = {}): Promise<Response> {
  const apiBase = appsApiBase();
  const usesPortalProxy = isPortalAppsProxyBase(apiBase);
  const storedToken = usesPortalProxy ? "" : window.localStorage.getItem("workspace_apps_token") ?? "";
  const token = usesPortalProxy ? "" : storedToken || await issueAppsToken();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("x-workspace-user-id", catalog.currentUser.email || catalog.currentUser.id);
  headers.set("x-workspace-scopes", appsScopes.join(","));
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  const timeoutController = init.signal ? undefined : new AbortController();
  const mateProvisioning = init.method?.toUpperCase() === "POST" && (
    path === "/mates/default"
    || path === "/mates"
    || /^\/mates\/[^/]+\/deploy$/.test(path)
    || /^\/mates\/[^/]+\/releases\/[^/]+\/publish$/.test(path)
  );
  const timeout = timeoutController
    ? setTimeout(
      () => timeoutController.abort(),
      mateProvisioning ? APPS_CREATION_TIMEOUT_MS : APPS_REQUEST_TIMEOUT_MS
    )
    : undefined;
  let response: Response;

  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? timeoutController?.signal
    });
  } catch (error) {
    if (timeoutController?.signal.aborted) {
      throw new AppsApiError(0, "apps_request_timeout");
    }
    if (init.signal?.aborted) {
      throw error;
    }
    throw new AppsApiError(0, "apps_worker_unavailable");
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }

  if (!response.ok) {
    if ((response.status === 401 || response.status === 403) && storedToken) {
      window.localStorage.removeItem("workspace_apps_token");
      return appsApiRequest(path, catalog, init);
    }

    throw await appsResponseError(response);
  }

  return response;
}

export async function downloadAppsSourceSnapshot(appId: string, snapshotId: string, catalog: PortalCatalog) {
  const apiBase = appsApiBase();
  const downloadPath = `/apps/${encodeURIComponent(appId)}/source-snapshots/${encodeURIComponent(snapshotId)}/download`;

  // Keep the download inside the original user gesture when Portal owns the
  // authenticated proxy. Fetching the archive into a Blob first can cause
  // managed browsers to reject the later synthetic download click.
  if (isPortalAppsProxyBase(apiBase)) {
    const anchor = document.createElement("a");
    anchor.href = `${apiBase}${downloadPath}`;
    anchor.download = `${appId}-${snapshotId}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return;
  }

  const response = await appsApiRequest(
    downloadPath,
    catalog,
    { headers: { Accept: "application/zip" } }
  );
  const blobUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = responseFileName(response) || `${appId}-${snapshotId}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
}

async function appsResponseError(response: Response) {
  let payload: { error?: unknown; requestId?: unknown } = {};
  try {
    payload = await response.json() as typeof payload;
  } catch {
    payload = {};
  }

  const rawCode = typeof payload.error === "string" ? payload.error : "";
  const code = KNOWN_APPS_API_ERROR_CODES.has(rawCode) ? rawCode : "apps_api_unavailable";
  const requestId = typeof payload.requestId === "string"
    ? payload.requestId
    : response.headers.get("x-request-id") ?? "";
  return new AppsApiError(response.status, code, requestId);
}

export async function issueAppsToken() {
  try {
    const response = await fetch("/api/apps/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: appsScopes })
    });

    if (!response.ok) {
      return "";
    }

    const payload = await response.json() as { token?: string };
    const token = payload.token ?? "";
    if (token) {
      window.localStorage.setItem("workspace_apps_token", token);
    }
    return token;
  } catch {
    return "";
  }
}

export function appsApiBase() {
  return (import.meta.env.VITE_APPS_WORKER_URL ?? "/api/apps").replace(/\/$/, "");
}

function isPortalAppsProxyBase(value: string) {
  return value === "/api/apps" || value.startsWith("/api/apps/");
}

function responseFileName(response: Response) {
  const disposition = response.headers.get("content-disposition") ?? "";
  return disposition.match(/filename="([^"]+)"/i)?.[1] ?? "";
}
