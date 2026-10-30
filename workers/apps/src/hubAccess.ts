import { accessTargetsMatchPrincipal } from "./core/accessTargets";
import type { Principal } from "./core/types";
import { parseStringArray, readString } from "./core/utils";

export type HubAccessRow = {
  access_targets_json?: string;
  id: string;
  org_id: string;
  visibility: string;
};

export type HubConsumptionAccess = {
  publicAppIds: string[];
  appIds: string[];
  skillIds: string[];
};

export type HubConsumptionFilter = {
  targetIds?: string[];
  type?: "app" | "skill";
};

export async function listHubConsumptionAccess(
  db: D1Database,
  principal: Principal,
  filter: HubConsumptionFilter = {}
): Promise<HubConsumptionAccess> {
  const targetIds = Array.from(new Set(filter.targetIds?.map((targetId) => targetId.trim()).filter(Boolean) ?? [])).slice(0, 24);
  const targetClause = targetIds.length > 0
    ? `AND id IN (${targetIds.map(() => "?").join(", ")})`
    : "";
  const appStatement = db.prepare(
    `
    SELECT id, org_id, visibility, access_targets_json
    FROM apps_apps
    WHERE org_id = ?
      AND status = 'published'
      ${targetClause}
    ORDER BY updated_at DESC, name
    `
  );
  const skillStatement = db.prepare(
    `
    SELECT id, org_id, visibility, access_targets_json
    FROM apps_skills
    WHERE org_id = ?
      AND status != 'archived'
      ${targetClause}
    ORDER BY updated_at DESC, name
    `
  );
  const [apps, skills] = await Promise.all([
    filter.type === "skill"
      ? Promise.resolve({ results: [] as HubAccessRow[] })
      : appStatement.bind(principal.orgId, ...targetIds).all<HubAccessRow>(),
    filter.type === "app"
      ? Promise.resolve({ results: [] as HubAccessRow[] })
      : skillStatement.bind(principal.orgId, ...targetIds).all<HubAccessRow>()
  ]);

  return {
    publicAppIds: (apps.results ?? []).filter((row) => canConsumeAppsAsset(row, principal)
      && ["org", "company", "public"].includes(row.visibility.trim().toLowerCase())).map((row) => row.id),
    appIds: consumableIds(apps.results ?? [], principal),
    skillIds: consumableIds(skills.results ?? [], principal)
  };
}

export function canConsumeAppsAsset(row: HubAccessRow, principal: Principal) {
  if (row.org_id !== principal.orgId) {
    return false;
  }

  const visibility = readString(row.visibility).trim().toLowerCase();
  if (visibility === "org" || visibility === "company" || visibility === "public") {
    return true;
  }
  if (visibility !== "private" && visibility !== "team") {
    return false;
  }

  return accessTargetsMatchPrincipal(parseStringArray(row.access_targets_json), principal);
}

function consumableIds(rows: HubAccessRow[], principal: Principal) {
  return rows.filter((row) => canConsumeAppsAsset(row, principal)).map((row) => row.id);
}
