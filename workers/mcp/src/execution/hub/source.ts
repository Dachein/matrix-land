import { type Env, HttpError, type Principal } from "../../types.ts";
import { callAppsWorker } from "../clients/apps.ts";
import { legacyWorkspaceEmailIdentifier, normalizeAppsUserIdentifier } from "../identity.ts";
import { readOptionalString, readRecord, readRecordArray, readStringList } from "../values.ts";
import { hubVisibilityFromAppsVisibility } from "./input.ts";
import type { HubSubmissionTargetType, AppsHubSubmissionSource } from "./types.ts";

export async function readAppsHubSubmissionSource(
  env: Env,
  principal: Principal,
  targetType: HubSubmissionTargetType,
  targetId: string,
  requestedVersion?: string
): Promise<AppsHubSubmissionSource> {
  if (targetType === "app") {
    const payload = await callAppsWorker(env, principal, `/apps/${encodeURIComponent(targetId)}`, {
      appsScopes: ["apps:apps:read"]
    });
    const app = readRecord(readRecord(payload).app);
    const appId = readOptionalString(app.id);

    if (!appId || !principalCanManageAppsSource(app, principal)) {
      throw new HttpError(404, "apps_app_not_found");
    }

    const version = requestedVersion ?? readOptionalString(app.lastDeployedAt) ?? readOptionalString(app.updatedAt) ?? "1.0.0";
    const description = readOptionalString(app.description) ?? "";

    return {
      builderSnapshot: {
        app,
        manifest: readRecord(app.manifest)
      },
      defaultCategory: "Workflow",
      defaultDescription: description,
      defaultName: readOptionalString(app.name) ?? appId,
      defaultSummary: description,
      defaultTags: ["apps", "app", readOptionalString(app.type) ?? "app"].filter((tag): tag is string => Boolean(tag)),
      defaultVisibility: hubVisibilityFromAppsVisibility(app.visibility),
      verification: {
        appStatus: readOptionalString(app.status),
        appVisibility: readOptionalString(app.visibility),
        checkedAt: new Date().toISOString(),
        source: "apps-worker",
        targetId,
        targetType
      },
      version,
      versionId: version
    };
  }

  const payload = await callAppsWorker(env, principal, `/skills/${encodeURIComponent(targetId)}`, {
    appsScopes: ["apps:skills:read"]
  });
  const skill = readRecord(readRecord(payload).skill);
  const skillId = readOptionalString(skill.id);
  const versions = readRecordArray(skill.versions);

  if (!skillId || !principalCanManageAppsSource(skill, principal)) {
    throw new HttpError(404, "apps_skill_not_found");
  }

  const requested = requestedVersion
    ? versions.find((version) => {
        const id = readOptionalString(version.id);
        const value = readOptionalString(version.version);
        return requestedVersion === id || requestedVersion === value;
      })
    : undefined;

  if (requestedVersion && !requested) {
    throw new HttpError(404, "apps_skill_version_not_found");
  }

  const selected = requested
    ?? versions.find((version) => readOptionalString(version.id) === readOptionalString(skill.currentVersionId))
    ?? versions[0];

  if (!selected) {
    throw new HttpError(404, "apps_skill_or_version_not_found");
  }

  const version = readOptionalString(selected.version) ?? requestedVersion ?? "1.0.0";
  const versionId = readOptionalString(selected.id) ?? version;
  const description = readOptionalString(skill.description) ?? "";
  const kind = readOptionalString(skill.kind) ?? "skill";

  return {
    builderSnapshot: {
      skill: {
        capabilities: Array.isArray(skill.capabilities) ? skill.capabilities : [],
        currentVersionId: skill.currentVersionId,
        id: skill.id,
        kind: skill.kind,
        name: skill.name,
        slug: skill.slug,
        status: skill.status,
        visibility: skill.visibility
      },
      version: selected
    },
    defaultCategory: "Research",
    defaultDescription: description,
    defaultName: readOptionalString(skill.name) ?? skillId,
    defaultSummary: description,
    defaultTags: ["apps", "skill", kind, ...readStringList(skill.capabilities)].slice(0, 8),
    defaultVisibility: "org",
    verification: {
      artifactSha256: readOptionalString(selected.artifactSha256),
      checkedAt: new Date().toISOString(),
      source: "apps-worker",
      targetId,
      targetType,
      version,
      versionId
    },
    version,
    versionId
  };
}

function principalCanManageAppsSource(asset: Record<string, unknown>, principal: Principal) {
  const principalIdentifiers = new Set([
    principal.sub,
    principal.email,
    legacyWorkspaceEmailIdentifier(principal.email)
  ].map(normalizeAppsUserIdentifier).filter(Boolean));
  const ownerUserId = normalizeAppsUserIdentifier(asset.ownerUserId);
  if (ownerUserId && principalIdentifiers.has(ownerUserId)) {
    return true;
  }

  return Array.isArray(asset.collaboratorUserIds)
    && asset.collaboratorUserIds
      .filter((identifier): identifier is string => typeof identifier === "string")
      .map(normalizeAppsUserIdentifier)
      .some((identifier) => principalIdentifiers.has(identifier));
}
