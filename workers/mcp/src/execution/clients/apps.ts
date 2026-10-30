import { missingConfiguration } from "../../../../../src/shared/requiredConfiguration.ts";
import { signJwt } from "../../auth.ts";
import { readString } from "../../http.ts";
import { type Env, HttpError, type Principal } from "../../types.ts";
import { bytesToBase64 } from "../values.ts";

// Forward APPS requests and source downloads while preserving actor identity and upstream errors.
export async function downloadCurrentAppsSource(env: Env, principal: Principal, appId: string) {
  const response = await callAppsWorkerBinary(
    env,
    principal,
    `/apps/${encodeURIComponent(appId)}/current-source/download`
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const deploymentId = response.headers.get("x-workspace-deployment-id")?.trim() ?? "";
  const deploymentVersion = response.headers.get("x-workspace-deployment-version")?.trim() ?? "";
  const sourceSnapshotId = response.headers.get("x-workspace-source-snapshot-id")?.trim() ?? "";
  const archiveSha256 = response.headers.get("x-workspace-source-archive-sha256")?.trim() ?? "";
  const contentSha256 = response.headers.get("x-workspace-source-content-sha256")?.trim() ?? "";
  if (!deploymentId || !deploymentVersion || !sourceSnapshotId || !archiveSha256 || !contentSha256) {
    throw new HttpError(502, "apps_current_source_metadata_missing");
  }
  return {
    appId,
    deployment: {
      id: deploymentId,
      version: deploymentVersion,
      status: "published"
    },
    sourceSnapshot: {
      id: sourceSnapshotId,
      archiveSha256,
      contentSha256
    },
    package: {
      filename: responseAttachmentFileName(response) || `${appId}-${deploymentVersion}.zip`,
      mediaType: response.headers.get("content-type")?.split(";")[0]?.trim() || "application/zip",
      sizeBytes: bytes.byteLength,
      encoding: "base64",
      zipBase64: bytesToBase64(bytes)
    }
  };
}

async function callAppsWorkerBinary(env: Env, principal: Principal, path: string) {
  const baseUrl = (env.APPS_WORKER_URL?.trim() || missingConfiguration("APPS_WORKER_URL")).replace(/\/+$/, "");
  const appsScopes = ["apps:apps:read"];
  const token = await signJwt({
    typ: "mcp_access",
    iss: env.AUTH_ISSUER ?? missingConfiguration("AUTH_ISSUER"),
    sub: principal.sub,
    org_id: env.APPS_ORG_ID ?? missingConfiguration("WORKSPACE_ORG_ID"),
    org_slug: env.APPS_ORG_SLUG ?? "workspace",
    email: principal.email,
    name: principal.name,
    role: principal.role,
    department: principal.department,
    department_id: principal.departmentId,
    department_path: principal.departmentPath ?? [],
    team: principal.team,
    team_id: principal.teamId,
    team_path: principal.teamPath ?? [],
    scopes: appsScopes,
    exp: Math.floor(Date.now() / 1000) + 300
  }, env.WORKSPACE_MCP_JWT_SECRET ?? env.APPS_JWT_SECRET);
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/zip",
      Authorization: `Bearer ${token}`,
      "x-workspace-department-id": principal.departmentId ?? "",
      "x-workspace-department-path": JSON.stringify(principal.departmentPath ?? []),
      "x-workspace-user-id": principal.email ?? principal.sub,
      "x-workspace-org-id": env.APPS_ORG_ID ?? missingConfiguration("WORKSPACE_ORG_ID"),
      "x-workspace-org-slug": env.APPS_ORG_SLUG ?? "workspace",
      "x-workspace-scopes": appsScopes.join(","),
      "x-request-id": `workspace-mcp-${crypto.randomUUID()}`
    }
  });
  if (!response.ok) {
    const responseText = await response.text();
    let code = "apps_worker_request_failed";
    try {
      const payload = JSON.parse(responseText) as Record<string, unknown>;
      code = readString(payload.error).trim() || code;
    } catch {
      // Preserve the stable proxy error when the downstream body is not JSON.
    }
    throw new HttpError(
      response.status === 401 || response.status === 403 ? 502 : response.status,
      code,
      responseText.slice(0, 240)
    );
  }
  return response;
}

export async function callAppsWorker(
  env: Env,
  principal: Principal,
  path: string,
  options: {
    body?: Record<string, unknown>;
    listingId?: string;
    appsScopes?: string[];
    method?: "GET" | "POST";
    rpcArgs?: Record<string, unknown>;
    rpcMethod?: string;
    rpcName?: string;
    requestId?: string;
    skillId?: string;
    tokenType?: string;
  } = {}
) {
  const baseUrl = (env.APPS_WORKER_URL?.trim() || missingConfiguration("APPS_WORKER_URL")).replace(/\/+$/, "");
  const appsScopes = options.appsScopes ?? ["apps:apps:read", "apps:skills:read"];
  const token = await signJwt({
    typ: options.tokenType ?? "mcp_access",
    iss: env.AUTH_ISSUER ?? missingConfiguration("AUTH_ISSUER"),
    sub: principal.sub,
    org_id: env.APPS_ORG_ID ?? missingConfiguration("WORKSPACE_ORG_ID"),
    org_slug: env.APPS_ORG_SLUG ?? "workspace",
    email: principal.email,
    name: principal.name,
    role: principal.role,
    department: principal.department,
    department_id: principal.departmentId,
    department_path: principal.departmentPath ?? [],
    team: principal.team,
    team_id: principal.teamId,
    team_path: principal.teamPath ?? [],
    listing_id: options.listingId,
    skill_id: options.skillId,
    scopes: appsScopes,
    exp: Math.floor(Date.now() / 1000) + 300
  }, env.WORKSPACE_MCP_JWT_SECRET ?? env.APPS_JWT_SECRET);
  const downstreamRequestId = options.requestId?.trim() || `workspace-mcp-${crypto.randomUUID()}`;
  const body = options.rpcMethod
    ? {
      id: downstreamRequestId,
      method: options.rpcMethod,
      params: {
        arguments: options.rpcArgs ?? {},
        name: options.rpcName
      }
    }
    : options.body;
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-workspace-department-id": principal.departmentId ?? "",
      "x-workspace-department-path": JSON.stringify(principal.departmentPath ?? []),
      "x-workspace-user-id": principal.email ?? principal.sub,
      "x-workspace-org-id": env.APPS_ORG_ID ?? missingConfiguration("WORKSPACE_ORG_ID"),
      "x-workspace-org-slug": env.APPS_ORG_SLUG ?? "workspace",
      "x-workspace-scopes": appsScopes.join(","),
      "x-request-id": downstreamRequestId
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw new HttpError(response.status === 401 || response.status === 403 ? 502 : response.status, "apps_worker_request_failed", responseText.slice(0, 240));
  }

  if (!response.headers.get("content-type")?.includes("application/json")) {
    return responseText;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch {
    throw new HttpError(502, "apps_worker_invalid_json");
  }

  if (options.rpcMethod) {
    const rpc = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    if (rpc.error) {
      const error = appsWorkerRpcError(rpc.error);
      throw new HttpError(502, error.code, error.message);
    }
    return rpc.result ?? payload;
  }

  return payload;
}

function appsWorkerRpcError(value: unknown) {
  const error = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const data = error.data && typeof error.data === "object" && !Array.isArray(error.data)
    ? error.data as Record<string, unknown>
    : {};
  const code = readString(data.code || error.message).trim() || "apps_worker_rpc_failed";
  return {
    code,
    message: readString(error.message).trim() || code
  };
}

function responseAttachmentFileName(response: Response) {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded).replace(/[\\/]/g, "_");
    } catch {
      return encoded.replace(/[\\/]/g, "_");
    }
  }
  return disposition.match(/filename="([^"]+)"/i)?.[1]?.replace(/[\\/]/g, "_")
    ?? disposition.match(/filename=([^;]+)/i)?.[1]?.trim().replace(/[\\/]/g, "_")
    ?? "";
}
