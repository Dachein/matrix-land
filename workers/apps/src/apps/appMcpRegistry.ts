import {
  parseWorkspaceAppMcpManifest,
  type WorkspaceAppMcpManifest,
} from "../../../../src/shared/appMcpManifest.ts";
import { collaboratorUserIdsFromJson, principalCanManageAppsAsset } from "../core/collaborators.ts";
import { HttpError, type Env, type Principal } from "../core/types.ts";
import { parseStringArray, readString } from "../core/utils.ts";
import type { AppsAppRow } from "../db/rows.ts";
import { canConsumeAppsAsset } from "../hubAccess.ts";
import { runtimeUrls } from "../runtime/urls.ts";

const MCP_MANIFEST_PATH = ".well-known/workspace-mcp-manifest.json";

type SourceFile = {
  content: string;
  encoding: "base64" | "text";
  path: string;
};

type ManifestRow = AppsAppRow & {
  deployment_id: string;
  manifest_json: string;
  manifest_sha256: string;
  tool_definition_version: string;
};

export type AppMcpRegistration = {
  id: string;
  manifest: WorkspaceAppMcpManifest;
  manifestJson: string;
  manifestSha256: string;
};

export async function inspectAppMcpRegistration(
  app: AppsAppRow,
  files: SourceFile[],
  env: Env,
): Promise<AppMcpRegistration | undefined> {
  const source = files.find((file) => file.path === MCP_MANIFEST_PATH);
  if (app.agent_mcp_enabled !== 1) return undefined;
  if (!source) throw new HttpError(422, "app_mcp_manifest_required");

  let raw: unknown;
  try {
    raw = JSON.parse(source.encoding === "base64" ? decodeBase64(source.content) : source.content);
  } catch {
    throw new HttpError(422, "app_mcp_manifest_invalid_json");
  }

  let manifest: WorkspaceAppMcpManifest;
  try {
    const productionUrl = runtimeUrls(env, app.code || app.slug || app.id).productionUrl;
    manifest = parseWorkspaceAppMcpManifest(raw, {
      appId: app.id,
      audience: new URL(productionUrl).origin,
      baseUrl: productionUrl,
      resourceId: `app-mcp:${app.id}`,
    });
  } catch (error) {
    throw new HttpError(422, error instanceof Error ? error.message : "app_mcp_manifest_invalid");
  }

  const manifestJson = JSON.stringify(manifest);
  return {
    id: `mcpmanifest_${crypto.randomUUID().replaceAll("-", "")}`,
    manifest,
    manifestJson,
    manifestSha256: await sha256Hex(manifestJson),
  };
}

export async function listAccessibleMcpApps(env: Env, principal: Principal) {
  const rows = await env.APPS_DB.prepare(`
    SELECT a.*, d.id AS deployment_id, m.manifest_json, m.manifest_sha256, m.tool_definition_version
    FROM apps_apps a
    JOIN apps_deployments d ON d.app_id = a.id AND d.status = 'published'
    JOIN apps_app_mcp_manifests m ON m.app_id = a.id AND m.deployment_id = d.id
    WHERE a.org_id = ? AND a.status = 'published' AND a.agent_mcp_enabled = 1
    ORDER BY a.updated_at DESC, a.name
  `).bind(principal.orgId).all<ManifestRow>();

  return (rows.results ?? [])
    .filter((row) => canAccessMcpApp(row, principal))
    .flatMap((row) => {
      const manifest = safeManifest(row.manifest_json, row.id);
      return manifest ? [{
        appId: row.id,
        name: row.name,
        description: row.description,
        audience: manifest.audience,
        resourceId: manifest.resourceId,
        manifestVersion: manifest.schemaVersion,
        toolDefinitionVersion: row.tool_definition_version,
        manifestSha256: row.manifest_sha256,
      }] : [];
    });
}

export async function readAccessibleMcpApp(env: Env, principal: Principal, appId: string) {
  const row = await env.APPS_DB.prepare(`
    SELECT a.*, d.id AS deployment_id, m.manifest_json, m.manifest_sha256, m.tool_definition_version
    FROM apps_apps a
    JOIN apps_deployments d ON d.app_id = a.id AND d.status = 'published'
    JOIN apps_app_mcp_manifests m ON m.app_id = a.id AND m.deployment_id = d.id
    WHERE a.id = ? AND a.org_id = ? AND a.status = 'published' AND a.agent_mcp_enabled = 1
    LIMIT 1
  `).bind(appId, principal.orgId).first<ManifestRow>();
  if (!row || !canAccessMcpApp(row, principal)) throw new HttpError(404, "app_mcp_not_accessible");
  const manifest = safeManifest(row.manifest_json, row.id);
  if (!manifest) throw new HttpError(409, "app_mcp_manifest_snapshot_invalid");
  return { manifest, manifestSha256: row.manifest_sha256, deploymentId: row.deployment_id };
}

export async function syncPublishedAppMcpResource(env: Env, app: AppsAppRow, deploymentId: string, input: {
  accessTargets: string[];
  visibility: string;
}) {
  if (app.agent_mcp_enabled !== 1) return;
  const row = await env.APPS_DB.prepare(`
    SELECT manifest_json FROM apps_app_mcp_manifests
    WHERE app_id = ? AND deployment_id = ? LIMIT 1
  `).bind(app.id, deploymentId).first<{ manifest_json: string }>();
  if (!row) throw new HttpError(409, "app_mcp_manifest_snapshot_missing");
  const manifest = safeManifest(row.manifest_json, app.id);
  if (!manifest) throw new HttpError(409, "app_mcp_manifest_snapshot_invalid");

  await syncAppMcpResource(env, app, manifest, input, "listed");
}

export async function delistPublishedAppMcpResource(env: Env, app: AppsAppRow) {
  await syncCurrentPublishedAppMcpResource(env, app, "draft");
}

export async function relistPublishedAppMcpResource(env: Env, app: AppsAppRow) {
  return syncCurrentPublishedAppMcpResource(env, app, "listed");
}

export async function resyncPublishedAppMcpResource(env: Env, app: AppsAppRow, input?: {
  accessTargets: string[];
  visibility: string;
}) {
  if (app.agent_mcp_enabled !== 1 || app.status !== "published") return false;
  return syncCurrentPublishedAppMcpResource(env, app, "listed", input);
}

async function syncCurrentPublishedAppMcpResource(
  env: Env,
  app: AppsAppRow,
  status: "draft" | "listed",
  input?: { accessTargets: string[]; visibility: string },
) {
  const row = await env.APPS_DB.prepare(`
    SELECT m.manifest_json
    FROM apps_deployments d
    JOIN apps_app_mcp_manifests m ON m.app_id = d.app_id AND m.deployment_id = d.id
    WHERE d.app_id = ? AND d.status = 'published'
    ORDER BY d.created_at DESC
    LIMIT 1
  `).bind(app.id).first<{ manifest_json: string }>();
  if (!row) return;
  const manifest = safeManifest(row.manifest_json, app.id);
  if (!manifest) throw new HttpError(409, "app_mcp_manifest_snapshot_invalid");
  await syncAppMcpResource(env, app, manifest, input ?? {
    accessTargets: parseStringArray(app.access_targets_json),
    visibility: app.visibility,
  }, status);
  return true;
}

async function syncAppMcpResource(
  env: Env,
  app: AppsAppRow,
  manifest: WorkspaceAppMcpManifest,
  input: { accessTargets: string[]; visibility: string },
  status: "draft" | "listed",
) {
  const authOrigin = readString(env.AUTH_WORKER_URL || env.AUTH_ISSUER).trim().replace(/\/+$/, "");
  const token = readString(env.APPS_AUTH_SERVICE_TOKEN || env.AUTH_SERVICE_TOKEN).trim();
  if (!authOrigin || !token) throw new HttpError(503, "auth_worker_not_configured");
  const collaboratorTargets = collaboratorUserIdsFromJson(app.collaborator_user_ids_json).map((id) => `user:${id}`);
  const accessTargets = Array.from(new Set([...input.accessTargets, ...collaboratorTargets]));
  const accessMode = accessTargets.length > 0 || input.visibility === "private" || input.visibility === "team"
    ? "targeted"
    : "public";
  const allowedScopes = Array.from(new Set([
    manifest.authorization.toolsEndpointScope,
    ...manifest.tools.flatMap((tool) => tool.requiredScopes),
  ]));
  const response = await fetch(`${authOrigin}/v1/admin/resources`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: manifest.resourceId,
      name: manifest.name,
      audience: manifest.audience,
      allowedScopes,
      accessMode,
      accessTargets,
      businessOwnerUserId: app.owner_user_id,
      collaboratorUserIds: collaboratorUserIdsFromJson(app.collaborator_user_ids_json),
      publisherUserId: app.owner_user_id,
      status,
      systemRolePolicyVersion: app.updated_at,
    }),
  });
  if (!response.ok) {
    throw new HttpError(response.status === 401 || response.status === 403 ? 502 : response.status, "app_mcp_resource_sync_failed");
  }
}

function canAccessMcpApp(row: ManifestRow, principal: Principal) {
  return principalCanManageAppsAsset(row, principal) || canConsumeAppsAsset({
    id: row.id,
    org_id: row.org_id,
    visibility: row.visibility,
    access_targets_json: JSON.stringify(parseStringArray(row.access_targets_json)),
  }, principal);
}

function safeManifest(value: string, appId: string) {
  try {
    return parseWorkspaceAppMcpManifest(JSON.parse(value), { appId });
  } catch {
    return undefined;
  }
}

function decodeBase64(value: string) {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function sha256Hex(value: string) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
