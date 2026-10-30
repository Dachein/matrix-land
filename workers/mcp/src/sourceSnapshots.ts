import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import { resolvePrincipal, signJwt } from "./auth.ts";
import { bearerToken, readString } from "./http.ts";
import { HttpError, type Env, type Principal } from "./types.ts";

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-length",
  "content-type",
  "x-workspace-source-archive-sha256",
  "x-workspace-source-content-sha256",
  "x-workspace-source-file-count",
  "x-workspace-source-metadata",
  "x-workspace-source-size",
  "x-workspace-deploy-archive-sha256",
  "x-workspace-deploy-content-sha256",
  "x-workspace-deploy-content-size",
  "x-workspace-deploy-entrypoint",
  "x-workspace-deploy-file-count",
  "x-workspace-deploy-target"
];

const FORWARDED_RESPONSE_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-length",
  "content-type",
  "etag",
  "x-workspace-source-archive-sha256",
  "x-workspace-source-content-sha256",
  "x-workspace-deploy-archive-sha256",
  "x-workspace-deploy-content-sha256"
];

export async function resolveAppsSourceSnapshotPrincipal(
  request: Request,
  env: Env,
  appId: string,
  fetchImpl: typeof fetch = fetch
): Promise<Principal> {
  const configuredToken = env.WORKSPACE_SOURCE_SNAPSHOT_ACCEPTANCE_TOKEN?.trim() ?? "";
  const presentedToken = bearerToken(request);
  if (!configuredToken || !presentedToken || !await opaqueTokensMatch(configuredToken, presentedToken)) {
    return resolvePrincipal(request, env, fetchImpl);
  }

  const allowedAppId = env.WORKSPACE_SOURCE_SNAPSHOT_ACCEPTANCE_APP_ID?.trim() ?? "";
  const userId = env.WORKSPACE_SOURCE_SNAPSHOT_ACCEPTANCE_USER_ID?.trim() ?? "";
  if (!allowedAppId || !userId) {
    throw new HttpError(503, "source_snapshot_acceptance_identity_not_configured");
  }
  if (appId !== allowedAppId) {
    throw new HttpError(403, "source_snapshot_acceptance_app_forbidden");
  }

  return {
    clientId: "workspace-production-acceptance",
    email: env.WORKSPACE_SOURCE_SNAPSHOT_ACCEPTANCE_EMAIL?.trim() || "production-acceptance@example.invalid",
    name: "Workspace Production Acceptance",
    orgId: env.APPS_ORG_ID ?? missingConfiguration("WORKSPACE_ORG_ID"),
    role: "member",
    scopes: ["workspace:apps:read", "workspace:apps:write"],
    sub: userId
  };
}

export async function proxyAppsSourceSnapshotRequest(
  request: Request,
  env: Env,
  principal: Principal,
  downstreamPath: string,
  fetchImpl: typeof fetch = fetch
) {
  return proxyAppsArtifactRequest(request, env, principal, downstreamPath, "source_snapshot", fetchImpl);
}

export async function proxyAppsDeployArtifactRequest(
  request: Request,
  env: Env,
  principal: Principal,
  downstreamPath: string,
  fetchImpl: typeof fetch = fetch
) {
  return proxyAppsArtifactRequest(request, env, principal, downstreamPath, "deploy_artifact", fetchImpl);
}

async function proxyAppsArtifactRequest(
  request: Request,
  env: Env,
  principal: Principal,
  downstreamPath: string,
  kind: "deploy_artifact" | "source_snapshot",
  fetchImpl: typeof fetch
) {
  const write = request.method === "POST";
  const appsScopes = write
    ? ["apps:apps:write", "apps:apps:read"]
    : ["apps:apps:read"];
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

  const requestId = request.headers.get("x-request-id")?.trim() || `workspace-cli-${crypto.randomUUID()}`;
  const headers = forwardedHeaders(request.headers, FORWARDED_REQUEST_HEADERS);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("x-workspace-department-id", principal.departmentId ?? "");
  headers.set("x-workspace-department-path", JSON.stringify(principal.departmentPath ?? []));
  headers.set("x-workspace-org-id", env.APPS_ORG_ID ?? missingConfiguration("WORKSPACE_ORG_ID"));
  headers.set("x-workspace-org-slug", env.APPS_ORG_SLUG ?? "workspace");
  headers.set("x-workspace-scopes", appsScopes.join(","));
  headers.set("x-workspace-user-id", principal.email ?? principal.sub);
  headers.set("x-request-id", requestId);

  const baseUrl = (env.APPS_WORKER_URL?.trim() || missingConfiguration("APPS_WORKER_URL")).replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${downstreamPath}`, {
      method: request.method,
      headers,
      body: write ? request.body : undefined
    });
  } catch (error) {
    throw new HttpError(
      502,
      kind === "deploy_artifact" ? "apps_deploy_artifact_unavailable" : "apps_source_snapshot_unavailable",
      error instanceof Error ? error.message : `APPS ${kind.replaceAll("_", " ")} request failed`
    );
  }

  const responseHeaders = forwardedHeaders(response.headers, FORWARDED_RESPONSE_HEADERS);
  responseHeaders.set("Cache-Control", "private, no-store");
  if (!response.ok && !responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "application/json");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });
}

export function appsSourceSnapshotPath(appId: string, snapshotId?: string) {
  const app = readString(appId).trim();
  const snapshot = readString(snapshotId).trim();
  if (!app) throw new HttpError(400, "missing_app_id");
  const collection = `/apps/${encodeURIComponent(app)}/source-snapshots`;
  return snapshot ? `${collection}/${encodeURIComponent(snapshot)}/download` : collection;
}

export function appsDeployArtifactPath(appId: string, deployArtifactId?: string) {
  const app = readString(appId).trim();
  const artifact = readString(deployArtifactId).trim();
  if (!app) throw new HttpError(400, "missing_app_id");
  const collection = `/apps/${encodeURIComponent(app)}/deploy-artifacts`;
  return artifact ? `${collection}/${encodeURIComponent(artifact)}/download` : collection;
}

function forwardedHeaders(source: Headers, names: string[]) {
  const headers = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

async function opaqueTokensMatch(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    difference |= leftBytes[index] ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
