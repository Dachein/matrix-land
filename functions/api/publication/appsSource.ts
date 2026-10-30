import type { PortalCatalog } from "../../../src/shared/types.ts";
import type { PublicationSubmissionTargetType } from "./normalizers.ts";
import { normalizeUnknownObject } from "./normalizers.ts";

type CurrentUser = PortalCatalog["currentUser"];

type PublicationAppsSourceEnv = {
  APPS_JWT_SECRET?: string;
  APPS_ORG_ID?: string;
  APPS_ORG_SLUG?: string;
  APPS_WORKER_URL?: string;
  PORTAL_ISSUER?: string;
  TOKEN_TTL_SECONDS?: string;
};

type PublicationAppsSourceContext<TEnv extends PublicationAppsSourceEnv> = EventContext<TEnv, string, unknown>;

type PublicationAppsSourceDeps<TEnv extends PublicationAppsSourceEnv> = {
  fetch?: typeof fetch;
  getTtlSeconds(env: TEnv): number;
  httpError(status: number, message: string): Error;
  appsOrgContext(env: TEnv, currentUser: CurrentUser): { orgId: string; orgSlug: string };
  appsReadScopes: string[];
  appsWorkerBaseUrl(env: TEnv): string;
  parseJson(value: string): Record<string, unknown>;
  signAppsToken(env: TEnv, payload: Record<string, unknown>): Promise<string>;
};

export type AppsPublicationSource = {
  artifactUrl?: string;
  builderSnapshot: Record<string, unknown>;
  verification: Record<string, unknown>;
  version?: string;
  versionId?: string;
};

export type AppsPublicationAuthorIndex = {
  appIds: string[];
  collaboratedAppIds: string[];
  collaboratedSkillIds: string[];
  ownedAppIds: string[];
  ownedSkillIds: string[];
  skillIds: string[];
};

export type AppsPublicationAuthors = {
  ownerUserId: string;
  collaboratorUserIds: string[];
};

export type AppsPublicationHubAccessIndex = {
  publicAppIds?: string[];
  appIds: string[];
  skillIds: string[];
};

export function createPublicationAppsSourceReader<TEnv extends PublicationAppsSourceEnv>(deps: PublicationAppsSourceDeps<TEnv>) {
  const appsWorkerJson = createAppsWorkerJsonReader(deps);

  return async function readAppsPublicationSource(
    context: PublicationAppsSourceContext<TEnv>,
    currentUser: CurrentUser,
    targetType: PublicationSubmissionTargetType,
    targetId: string,
    requestedVersion?: string
  ): Promise<AppsPublicationSource> {
    if (targetType === "app") {
      const payload = await appsWorkerJson(context, currentUser, `/apps/${encodeURIComponent(targetId)}`);
      const app = normalizeUnknownObject(payload.app);

      if (!readOptionalString(app.id) || !currentUserCanManageAppsAsset(app, currentUser)) {
        throw deps.httpError(404, "apps_app_not_found");
      }

      const version = requestedVersion ?? readOptionalString(app.lastDeployedAt) ?? readOptionalString(app.updatedAt);

      return {
        builderSnapshot: {
          app,
          manifest: normalizeUnknownObject(app.manifest)
        },
        verification: {
          checkedAt: new Date().toISOString(),
          source: "apps-worker",
          targetType,
          targetId,
          appStatus: readOptionalString(app.status),
          appVisibility: readOptionalString(app.visibility)
        },
        version,
        versionId: version
      };
    }

    if (targetType === "skill") {
      const payload = await appsWorkerJson(context, currentUser, `/skills/${encodeURIComponent(targetId)}`);
      const skill = normalizeUnknownObject(payload.skill);
      const versions = Array.isArray(skill.versions) ? skill.versions.map(normalizeUnknownObject) : [];

      if (!readOptionalString(skill.id) || !currentUserCanManageAppsAsset(skill, currentUser)) {
        throw deps.httpError(404, "apps_skill_not_found");
      }

      const requested = requestedVersion
        ? versions.find((version) => {
            const id = readOptionalString(version.id);
            const value = readOptionalString(version.version);
            return requestedVersion === id || requestedVersion === value;
          })
        : undefined;

      if (requestedVersion && !requested) {
        throw deps.httpError(404, "apps_skill_version_not_found");
      }

      const selected = requested ?? versions.find((version) => {
        const id = readOptionalString(version.id);
        return id === readOptionalString(skill.currentVersionId);
      }) ?? versions[0];

      if (!selected) {
        throw deps.httpError(404, "apps_skill_or_version_not_found");
      }

      const version = readOptionalString(selected.version) ?? requestedVersion ?? "1.0.0";
      const versionId = readOptionalString(selected.id) ?? version;
      const artifactSha256 = readOptionalString(selected.artifactSha256);

      return {
        artifactUrl: `${new URL(context.request.url).origin}/api/apps/skills/${encodeURIComponent(targetId)}/versions/${encodeURIComponent(version)}/download.zip`,
        builderSnapshot: {
          skill: {
            id: skill.id,
            ownerUserId: skill.ownerUserId,
            collaboratorUserIds: Array.isArray(skill.collaboratorUserIds) ? skill.collaboratorUserIds : [],
            name: skill.name,
            slug: skill.slug,
            kind: skill.kind,
            capabilities: Array.isArray(skill.capabilities) ? skill.capabilities : [],
            status: skill.status,
            visibility: skill.visibility,
            currentVersionId: skill.currentVersionId
          },
          version: selected
        },
        verification: {
          checkedAt: new Date().toISOString(),
          source: "apps-worker",
          targetType,
          targetId,
          version,
          versionId,
          artifactSha256
        },
        version,
        versionId
      };
    }

    throw deps.httpError(400, "apps_publication_target_not_supported");
  };
}

export function createPublicationAppsAuthorIndexReader<TEnv extends PublicationAppsSourceEnv>(deps: PublicationAppsSourceDeps<TEnv>) {
  const appsWorkerJson = createAppsWorkerJsonReader(deps);

  return async function readAppsPublicationAuthorIndex(
    context: PublicationAppsSourceContext<TEnv>,
    currentUser: CurrentUser
  ): Promise<AppsPublicationAuthorIndex> {
    const [appsResult, skillsResult] = await Promise.allSettled([
      appsWorkerJson(context, currentUser, "/apps"),
      appsWorkerJson(context, currentUser, "/skills")
    ]);

    const apps = appsResult.status === "fulfilled"
      ? currentUserAssetIndex(appsResult.value.apps, currentUser)
      : emptyCurrentUserAssetIndex();
    const skills = skillsResult.status === "fulfilled"
      ? currentUserAssetIndex(skillsResult.value.skills, currentUser)
      : emptyCurrentUserAssetIndex();

    return {
      appIds: apps.managedIds,
      collaboratedAppIds: apps.collaboratedIds,
      collaboratedSkillIds: skills.collaboratedIds,
      ownedAppIds: apps.ownedIds,
      ownedSkillIds: skills.ownedIds,
      skillIds: skills.managedIds
    };
  };
}

export function createPublicationAppsHubAccessIndexReader<TEnv extends PublicationAppsSourceEnv>(deps: PublicationAppsSourceDeps<TEnv>) {
  const appsWorkerJson = createAppsWorkerJsonReader(deps);

  return async function readAppsPublicationHubAccessIndex(
    context: PublicationAppsSourceContext<TEnv>,
    currentUser: CurrentUser,
    targetIds: string[] = [],
    listingType?: "app" | "skill"
  ): Promise<AppsPublicationHubAccessIndex> {
    const searchParams = new URLSearchParams();
    if (targetIds.length > 0) searchParams.set("ids", targetIds.join(","));
    if (listingType) searchParams.set("type", listingType);
    const query = searchParams.toString();
    const payload = await appsWorkerJson(context, currentUser, `/hub-access${query ? `?${query}` : ""}`);

    return {
      ...(Array.isArray(payload.publicAppIds) ? { publicAppIds: hubAccessIds(payload.publicAppIds) } : {}),
      appIds: hubAccessIds(payload.appIds),
      skillIds: hubAccessIds(payload.skillIds)
    };
  };
}

export function createPublicationAppsSkillVisibilitySync<TEnv extends PublicationAppsSourceEnv>(deps: PublicationAppsSourceDeps<TEnv>) {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));

  return async function syncAppsSkillVisibility(
    context: PublicationAppsSourceContext<TEnv>,
    currentUser: CurrentUser,
    skillId: string,
    visibility: "org" | "team" | "private"
  ) {
    const { orgId, orgSlug } = deps.appsOrgContext(context.env, currentUser);
    const scopes = ["apps:skills:write"];
    const token = await deps.signAppsToken(context.env, {
      typ: "apps_publication_review",
      iss: context.env.PORTAL_ISSUER ?? "frontier-workspace",
      sub: currentUser.id,
      org_id: orgId,
      org_slug: orgSlug,
      provider: currentUser.identity.provider,
      oid: currentUser.identity.objectId,
      tid: currentUser.identity.tenantId,
      email: currentUser.email,
      name: currentUser.name,
      department: currentUser.department,
      department_id: currentUser.departmentId,
      department_path: currentUser.departmentPath ?? [],
      team: currentUser.team,
      skill_id: skillId,
      scopes,
      exp: Math.floor(Date.now() / 1000) + Math.min(deps.getTtlSeconds(context.env), 900)
    });
    const response = await fetchImpl(`${deps.appsWorkerBaseUrl(context.env)}/publication-review/skills/${encodeURIComponent(skillId)}/visibility`, {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-workspace-user-id": currentUser.email || currentUser.id,
        "x-workspace-org-id": orgId,
        "x-workspace-org-slug": orgSlug,
        "x-workspace-scopes": scopes.join(",")
      },
      body: JSON.stringify({ visibility })
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw deps.httpError(502, `apps_skill_visibility_sync_failed:${response.status}:${responseText.slice(0, 160)}`);
    }
  };
}

export function createPublicationAppsReviewAuthorReader<TEnv extends PublicationAppsSourceEnv>(deps: PublicationAppsSourceDeps<TEnv>) {
  const appsWorkerJson = createAppsWorkerJsonReader(deps);

  return async function readAppsPublicationAuthors(
    context: PublicationAppsSourceContext<TEnv>,
    currentUser: CurrentUser,
    targetType: PublicationSubmissionTargetType,
    targetId: string
  ): Promise<AppsPublicationAuthors> {
    if (targetType !== "app" && targetType !== "skill") {
      throw deps.httpError(400, "apps_publication_target_not_supported");
    }

    const collection = targetType === "app" ? "apps" : "skills";
    const scope = targetType === "app" ? "apps:apps:read" : "apps:skills:read";
    const payload = await appsWorkerJson(
      context,
      currentUser,
      `/publication-review/${collection}/${encodeURIComponent(targetId)}/authors`,
      {
        tokenType: "apps_publication_review",
        scopes: [scope],
        ...(targetType === "app" ? { appId: targetId } : { skillId: targetId })
      }
    );
    const authors = normalizeUnknownObject(payload.authors);
    const ownerUserId = readOptionalString(authors.ownerUserId);
    if (!ownerUserId) {
      throw deps.httpError(502, "apps_worker_author_projection_invalid");
    }

    return {
      ownerUserId,
      collaboratorUserIds: hubAccessIds(authors.collaboratorUserIds)
    };
  };
}

type AppsWorkerCredential = {
  appId?: string;
  scopes?: string[];
  skillId?: string;
  tokenType?: string;
};

function createAppsWorkerJsonReader<TEnv extends PublicationAppsSourceEnv>(deps: PublicationAppsSourceDeps<TEnv>) {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));

  return async function appsWorkerJson(
    context: PublicationAppsSourceContext<TEnv>,
    currentUser: CurrentUser,
    path: string,
    credential: AppsWorkerCredential = {}
  ) {
    const { orgId, orgSlug } = deps.appsOrgContext(context.env, currentUser);
    const scopes = credential.scopes ?? deps.appsReadScopes;
    const token = await deps.signAppsToken(context.env, {
      typ: credential.tokenType ?? "apps_access",
      iss: context.env.PORTAL_ISSUER ?? "frontier-workspace",
      sub: currentUser.id,
      org_id: orgId,
      org_slug: orgSlug,
      provider: currentUser.identity.provider,
      oid: currentUser.identity.objectId,
      tid: currentUser.identity.tenantId,
      email: currentUser.email,
      department: currentUser.department,
      department_id: currentUser.departmentId,
      department_path: currentUser.departmentPath ?? [],
      team: currentUser.team,
      app_id: credential.appId,
      skill_id: credential.skillId,
      scopes,
      exp: Math.floor(Date.now() / 1000) + Math.min(deps.getTtlSeconds(context.env), 900)
    });
    const response = await fetchImpl(`${deps.appsWorkerBaseUrl(context.env)}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "x-workspace-user-id": currentUser.email || currentUser.id,
        "x-workspace-org-id": orgId,
        "x-workspace-org-slug": orgSlug,
        "x-workspace-scopes": scopes.join(","),
        ...(currentUser.department ? { "x-workspace-department-name": currentUser.department } : {}),
        ...(currentUser.departmentId ? { "x-workspace-department-id": currentUser.departmentId } : {}),
        ...(currentUser.departmentPath?.length ? { "x-workspace-department-path": JSON.stringify(currentUser.departmentPath) } : {}),
        ...(currentUser.team ? { "x-workspace-team-name": currentUser.team } : {})
      }
    });
    const responseText = await response.text();

    if (!response.ok) {
      throw deps.httpError(response.status === 404 ? 404 : 502, `apps_worker_validation_failed:${response.status}:${responseText.slice(0, 160)}`);
    }

    return deps.parseJson(responseText);
  };
}

function hubAccessIds(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)));
}

function currentUserAssetIndex(value: unknown, currentUser: CurrentUser) {
  if (!Array.isArray(value)) {
    return emptyCurrentUserAssetIndex();
  }

  const managedIds = new Set<string>();
  const ownedIds = new Set<string>();
  const collaboratedIds = new Set<string>();

  value.map(normalizeUnknownObject).forEach((asset) => {
    const assetId = readOptionalString(asset.id);
    if (!assetId) {
      return;
    }

    if (currentUserOwnsAppsAsset(asset, currentUser)) {
      managedIds.add(assetId);
      ownedIds.add(assetId);
      return;
    }

    if (currentUserCollaboratesOnAppsAsset(asset, currentUser)) {
      managedIds.add(assetId);
      collaboratedIds.add(assetId);
    }
  });

  return {
    collaboratedIds: Array.from(collaboratedIds),
    managedIds: Array.from(managedIds),
    ownedIds: Array.from(ownedIds)
  };
}

function emptyCurrentUserAssetIndex() {
  return {
    collaboratedIds: [] as string[],
    managedIds: [] as string[],
    ownedIds: [] as string[]
  };
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

function currentUserCanManageAppsAsset(asset: Record<string, unknown>, currentUser: CurrentUser) {
  return currentUserOwnsAppsAsset(asset, currentUser)
    || currentUserCollaboratesOnAppsAsset(asset, currentUser);
}

function currentUserOwnsAppsAsset(asset: Record<string, unknown>, currentUser: CurrentUser) {
  const currentUserIdentifiers = currentUserIdentityAliases(currentUser);
  const ownerUserId = normalizeUserIdentifier(asset.ownerUserId);
  return Boolean(ownerUserId && currentUserIdentifiers.has(ownerUserId));
}

function currentUserCollaboratesOnAppsAsset(asset: Record<string, unknown>, currentUser: CurrentUser) {
  const currentUserIdentifiers = currentUserIdentityAliases(currentUser);
  return Array.isArray(asset.collaboratorUserIds)
    && asset.collaboratorUserIds
      .filter((identifier): identifier is string => typeof identifier === "string")
      .map(normalizeUserIdentifier)
      .some((identifier) => currentUserIdentifiers.has(identifier));
}

function currentUserIdentityAliases(currentUser: CurrentUser) {
  return new Set([
    currentUser.id,
    currentUser.email,
    currentUser.identity?.objectId,
    currentUser.identity?.principalName,
    legacyWorkspaceEmailIdentifier(currentUser.email)
  ].map(normalizeUserIdentifier).filter(Boolean));
}

function normalizeUserIdentifier(value: unknown) {
  return readString(value)
    .trim()
    .toLowerCase();
}

function legacyWorkspaceEmailIdentifier(value: string | undefined) {
  const email = normalizeUserIdentifier(value);
  return email.endsWith("@example.invalid")
    ? email
    : "";
}
