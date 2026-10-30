import type { AppsApp } from "../../../../src/shared/types";
import { collaboratorUserIdsFromJson, principalCanManageAppsAsset } from "../core/collaborators";
import { normalizeAppType, normalizeStatus, normalizeVisibility } from "../core/normalizers";
import { HttpError, type Env, type Principal } from "../core/types";
import { normalizeAppCode, parseStringArray, readOptionalString } from "../core/utils";
import type { AppsAppEnvVarRow, AppsAppRow, AppsAppSecretRow, AppsDeploymentRow, AppsDomainRow, AppsResourceRow } from "../db/rows";
import { deploymentFromRow, domainFromRow, resourceFromRow, runtimeManifest, secretFromRow } from "./mappers";

export async function listApps(db: D1Database, env: Env, principal: Principal): Promise<AppsApp[]> {
  const rows = await db
    .prepare(
      `
      SELECT
        apps_apps.*,
        (
          SELECT MAX(created_at)
          FROM apps_deployments
          WHERE apps_deployments.app_id = apps_apps.id
            AND apps_deployments.status IN ('ready', 'published')
        ) AS last_deployed_at
      FROM apps_apps
      WHERE org_id = ?
      ORDER BY updated_at DESC, name
      `
    )
    .bind(principal.orgId)
    .all<AppsAppRow>();

  return hydrateApps(db, env, (rows.results ?? []).filter((row) => canReadApp(row, principal)));
}

export async function listPublicApps(db: D1Database, env: Env, principal: Principal): Promise<AppsApp[]> {
  const rows = await db
    .prepare(
      `
      SELECT
        apps_apps.*,
        (
          SELECT MAX(created_at)
          FROM apps_deployments
          WHERE apps_deployments.app_id = apps_apps.id
            AND apps_deployments.status IN ('ready', 'published')
        ) AS last_deployed_at
      FROM apps_apps
      WHERE status = 'published'
        AND org_id = ?
      ORDER BY updated_at DESC, name
      `
    )
    .bind(principal.orgId)
    .all<AppsAppRow>();

  return hydrateApps(db, env, (rows.results ?? []).filter((row) => canReadApp(row, principal)));
}

export async function readApp(db: D1Database, env: Env, principal: Principal, appId: string): Promise<AppsApp> {
  const row = await db.prepare("SELECT * FROM apps_apps WHERE id = ? LIMIT 1").bind(appId).first<AppsAppRow>();

  if (!row || !canReadApp(row, principal)) {
    throw new HttpError(404, "apps_app_not_found");
  }

  return hydrateApp(db, env, row);
}

export async function requireWritableApp(db: D1Database, principal: Principal, appId: string): Promise<AppsAppRow> {
  const row = await db.prepare("SELECT * FROM apps_apps WHERE id = ? LIMIT 1").bind(appId).first<AppsAppRow>();

  if (!row || !canManageApp(row, principal)) {
    throw new HttpError(404, "apps_app_not_found");
  }

  if (row.ownership_sync_pending) throw new HttpError(409, 'apps_ownership_sync_pending');
  return row;
}

export async function hydrateApps(db: D1Database, env: Env, rows: AppsAppRow[]): Promise<AppsApp[]> {
  return Promise.all(rows.map((row) => hydrateApp(db, env, row)));
}

export async function hydrateApp(db: D1Database, env: Env, row: AppsAppRow): Promise<AppsApp> {
  const [resources, secrets, deployments, domains, envVars, currentMcpRegistration] = await Promise.all([
    db
      .prepare("SELECT * FROM apps_app_resources WHERE app_id = ? ORDER BY environment, type")
      .bind(row.id)
      .all<AppsResourceRow>(),
    db
      .prepare("SELECT * FROM apps_app_secrets WHERE app_id = ? ORDER BY environment, name")
      .bind(row.id)
      .all<AppsAppSecretRow>()
      .catch(() => ({ results: [] as AppsAppSecretRow[] })),
    db
      .prepare("SELECT * FROM apps_deployments WHERE app_id = ? ORDER BY created_at DESC")
      .bind(row.id)
      .all<AppsDeploymentRow>(),
    db
      .prepare("SELECT * FROM apps_domains WHERE app_id = ? ORDER BY environment, type")
      .bind(row.id)
      .all<AppsDomainRow>(),
    db
      .prepare("SELECT * FROM apps_app_env_vars WHERE app_id = ? AND environment = 'production' ORDER BY target, name")
      .bind(row.id)
      .all<AppsAppEnvVarRow>()
      .catch(() => ({ results: [] as AppsAppEnvVarRow[] })),
    db
      .prepare(`
        SELECT 1 AS registered
        FROM apps_deployments d
        JOIN apps_app_mcp_manifests m ON m.app_id = d.app_id AND m.deployment_id = d.id
        WHERE d.app_id = ? AND d.status = 'published'
        LIMIT 1
      `)
      .bind(row.id)
      .first<{ registered: number }>()
      .catch(() => null)
  ]);
  const normalizedResources = (resources.results ?? []).map(resourceFromRow);
  const normalizedSecrets = (secrets.results ?? []).map(secretFromRow);
  const normalizedDeployments = (deployments.results ?? []).map(deploymentFromRow);
  const normalizedDomains = (domains.results ?? []).map(domainFromRow);
  const manifest = runtimeManifest(env, row, normalizedResources, normalizedSecrets, envVars.results ?? []);
  manifest.mcp.registered = row.agent_mcp_enabled === 1 && currentMcpRegistration?.registered === 1;
  const ownerTeamId = row.org_id;
  const appCode = appCodeFromRow(row);

  return {
    id: row.id,
    orgId: row.org_id,
    ownerUserId: row.owner_user_id,
    collaboratorUserIds: collaboratorUserIdsFromJson(row.collaborator_user_ids_json),
    ownerTeamId,
    name: row.name,
    appCode,
    slug: appCode,
    description: row.description,
    type: normalizeAppType(row.type),
    status: normalizeStatus(row.status),
    visibility: normalizeVisibility(row.visibility, "private"),
    accessTargets: parseStringArray(row.access_targets_json),
    directoryReadScope: row.directory_read_scope === "company" ? "company" : "app",
    loginRequired: row.login_required === 1,
    agentMcpEnabled: row.agent_mcp_enabled === 1,
    llmEnabled: row.llm_enabled === 1,
    llmDefaultModel: readOptionalString(row.llm_default_model),
    llmEndpoint: readOptionalString(row.llm_endpoint),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastDeployedAt: row.last_deployed_at,
    productionUrl: manifest.runtime.productionUrl,
    dataServiceId: row.data_service_id,
    resources: normalizedResources,
    secrets: normalizedSecrets,
    deployments: normalizedDeployments,
    domains: normalizedDomains,
    manifest
  };
}

export function canReadApp(row: AppsAppRow, principal: Principal) {
  return canManageApp(row, principal);
}

export function canManageApp(row: AppsAppRow, principal: Principal) {
  return principalCanManageAppsAsset(row, principal);
}

export function appCodeFromRow(row: AppsAppRow) {
  return normalizeAppCode(row.code) || normalizeAppCode(row.slug);
}
