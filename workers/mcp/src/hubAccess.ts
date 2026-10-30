import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import { signJwt } from "./auth.ts";
import { HttpError, type Env, type Principal } from "./types.ts";

type FetchLike = typeof fetch;

export type HubAccessListing = {
  configJson?: unknown;
  targetId?: unknown;
  targetPlane?: unknown;
  type?: unknown;
  visibility?: unknown;
};

type AppsHubAccess = {
  appIds: Set<string>;
  skillIds: Set<string>;
};

export async function filterHubListingsForPrincipal<T extends HubAccessListing>(
  listings: T[],
  env: Env,
  principal: Principal,
  deps: { fetch?: FetchLike } = {}
): Promise<T[]> {
  const appsAccess = listings.some(isAppsListing)
    ? await readAppsHubAccess(env, principal, deps.fetch)
    : undefined;

  return listings.filter((listing) => canConsumeHubListing(listing, principal, appsAccess));
}

function canConsumeHubListing(listing: HubAccessListing, principal: Principal, appsAccess?: AppsHubAccess) {
  if (isAppsListing(listing)) {
    const targetId = readString(listing.targetId).trim();
    if (!targetId || !appsAccess) {
      return false;
    }
    return readString(listing.type).trim().toLowerCase() === "app"
      ? appsAccess.appIds.has(targetId)
      : readString(listing.type).trim().toLowerCase() === "skill" && appsAccess.skillIds.has(targetId);
  }

  const visibility = readString(listing.visibility).trim().toLowerCase();
  const policy = listingAccessPolicy(listing.configJson);
  if (visibility === "company" || visibility === "org" || visibility === "public") {
    return policy.accessMode === "targeted" || policy.targets.length > 0
      ? policy.targets.some((target) => accessTargetMatchesPrincipal(target, principal))
      : true;
  }
  if (visibility !== "team" && visibility !== "private") {
    return false;
  }

  return policy.targets.length > 0
    && policy.targets.some((target) => accessTargetMatchesPrincipal(target, principal));
}

async function readAppsHubAccess(env: Env, principal: Principal, fetchImpl: FetchLike = fetch): Promise<AppsHubAccess> {
  const baseUrl = (env.APPS_WORKER_URL?.trim() || missingConfiguration("APPS_WORKER_URL")).replace(/\/+$/, "");
  const appsScopes = ["apps:apps:read", "apps:skills:read"];
  const orgId = env.APPS_ORG_ID ?? principal.orgId ?? missingConfiguration("WORKSPACE_ORG_ID");
  const orgSlug = env.APPS_ORG_SLUG ?? "workspace";
  const token = await signJwt({
    typ: "mcp_access",
    iss: env.AUTH_ISSUER ?? missingConfiguration("AUTH_ISSUER"),
    sub: principal.sub,
    org_id: orgId,
    org_slug: orgSlug,
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
  const response = await fetchImpl(`${baseUrl}/hub-access`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "x-workspace-department-id": principal.departmentId ?? "",
      "x-workspace-department-path": JSON.stringify(principal.departmentPath ?? []),
      "x-workspace-org-id": orgId,
      "x-workspace-org-slug": orgSlug,
      "x-workspace-scopes": appsScopes.join(","),
      "x-workspace-user-id": principal.email ?? principal.sub
    }
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new HttpError(502, "apps_hub_access_failed", responseText.slice(0, 240));
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(responseText) as unknown;
    payload = isRecord(parsed) ? parsed : {};
  } catch {
    throw new HttpError(502, "apps_hub_access_invalid_json");
  }

  if (!Array.isArray(payload.appIds) || !Array.isArray(payload.skillIds)) {
    throw new HttpError(502, "apps_hub_access_invalid_payload");
  }

  return {
    appIds: new Set(payload.appIds.map(readString).map((value) => value.trim()).filter(Boolean)),
    skillIds: new Set(payload.skillIds.map(readString).map((value) => value.trim()).filter(Boolean))
  };
}

function isAppsListing(listing: HubAccessListing) {
  return readString(listing.targetPlane).trim().toLowerCase() === "apps";
}

function listingAccessPolicy(configJson: unknown) {
  const config = parseJsonRecord(configJson);
  const builderSnapshot = readRecord(config.builderSnapshot ?? config.builder_snapshot);
  const reviewDraft = readRecord(config.reviewDraft ?? config.review_draft);
  const builderReviewDraft = readRecord(builderSnapshot.reviewDraft ?? builderSnapshot.review_draft);
  const resourceApi = readRecord(config.resourceApi ?? config.resource_api ?? config.mcpBroker ?? config.mcp_broker);
  const app = readRecord(config.app ?? builderSnapshot.app);

  const targets = Array.from(new Set([
    ...readStringArray(config.accessTargets ?? config.access_targets),
    ...readStringArray(reviewDraft.accessTargets ?? reviewDraft.access_targets),
    ...readStringArray(builderReviewDraft.accessTargets ?? builderReviewDraft.access_targets),
    ...readStringArray(resourceApi.accessTargets ?? resourceApi.access_targets),
    ...readStringArray(app.accessTargets ?? app.access_targets)
  ].map((target) => target.trim()).filter(Boolean)));
  const accessMode = [
    config.accessMode,
    config.access_mode,
    reviewDraft.accessMode,
    reviewDraft.access_mode,
    builderReviewDraft.accessMode,
    builderReviewDraft.access_mode,
    resourceApi.accessMode,
    resourceApi.access_mode,
    app.accessMode,
    app.access_mode
  ].map(readString).map((value) => value.trim().toLowerCase()).find(Boolean);
  return { accessMode, targets };
}

function accessTargetMatchesPrincipal(target: string, principal: Principal) {
  const normalized = target.trim().toLowerCase();
  if (normalized.startsWith("user:")) {
    const expected = normalizeUserIdentifier(normalized.slice("user:".length));
    return principalUserIdentifiers(principal).some((candidate) => normalizeUserIdentifier(candidate) === expected);
  }
  if (!normalized.startsWith("department:")) {
    return false;
  }

  const expected = normalizeDepartmentPath(normalized.slice("department:".length));
  return principalDepartmentLineage(principal).some((candidate) => (
    candidate === expected || candidate.startsWith(`${expected}/`)
  ));
}

function principalUserIdentifiers(principal: Principal) {
  const email = readString(principal.email).trim().toLowerCase();
  return Array.from(new Set([principal.sub, email].map(readString).filter(Boolean)));
}

function principalDepartmentLineage(principal: Principal) {
  return Array.from(new Set([
    principal.departmentId,
    ...(principal.departmentPath ?? [])
  ].map(normalizeDepartmentPath).filter(Boolean)));
}

function normalizeDepartmentPath(value: unknown) {
  return readString(value)
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join("/");
}

function normalizeUserIdentifier(value: unknown) {
  return readString(value)
    .trim()
    .toLowerCase();
}

function parseJsonRecord(value: unknown) {
  if (isRecord(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(readString).filter(Boolean);
  }
  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map(readString).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
