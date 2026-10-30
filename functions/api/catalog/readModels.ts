import type { PortalCatalog } from "../../../src/shared/types.ts";
import { MAX_ACTIVITY_EVENT_LIMIT } from "../activity/normalizers.ts";
import { readActivityEvents } from "../activity/service.ts";
import { readPortalJourney } from "../journey/service.ts";
import {
  appFromRow,
  dataServiceFromRow,
  publicationListingFromRow,
  mcpToolFromRow,
  skillFromRow
} from "./mappers.ts";
import { assetUserProfileFromRow } from "./utils.ts";
import type { CatalogCoverColumns, CatalogDeps, CatalogEnv, CurrentUser, UserProfileColumns } from "./types.ts";
import {
  PUBLICATION_EFFECTIVE_VERSION_PROJECTION_JOIN_SQL,
  PUBLICATION_LISTING_VERSION_PROJECTION_CTE_SQL,
  PUBLICATION_VERSION_PROJECTION_JOIN_SQL
} from "../publication/versionProjection.ts";

export async function readCategories(db: D1Database) {
  const rows = await db.prepare("SELECT name FROM skill_categories ORDER BY name").all<{ name: string }>();
  return (rows.results ?? []).map((row) => String(row.name));
}

export async function readPublicationListings(
  db: D1Database,
  currentUser: CurrentUser,
  userColumns: UserProfileColumns,
  coverColumns: CatalogCoverColumns,
  additionalAuthorListingIds: string[] = [],
  options: {
    attachOwnerProfiles?: boolean;
    includeAllListed?: boolean;
    listingType?: "app" | "skill";
    statusView?: "desired" | "effective";
    targetIds?: string[];
  } = {}
) {
  const statusColumn = options.statusView === "effective"
    ? "publication_listings.effective_status"
    : "publication_listings.desired_status";
  const versionProjectionJoin = options.statusView === "effective"
    ? PUBLICATION_EFFECTIVE_VERSION_PROJECTION_JOIN_SQL
    : PUBLICATION_VERSION_PROJECTION_JOIN_SQL;
  const authorizedListingIds = Array.from(new Set(
    additionalAuthorListingIds.map((listingId) => String(listingId).trim()).filter(Boolean)
  ));
  const additionalAuthorClause = authorizedListingIds.length > 0
    ? `OR publication_listings.id IN (${authorizedListingIds.map(() => "?").join(", ")})`
    : "";
  const listedDiscoveryClause = options.includeAllListed
    ? `OR ${statusColumn} = 'listed'`
    : "";
  const targetIds = Array.from(new Set(options.targetIds?.map((targetId) => targetId.trim()).filter(Boolean) ?? [])).slice(0, 24);
  const targetClause = targetIds.length > 0
    ? `AND publication_listings.target_id IN (${targetIds.map(() => "?").join(", ")})`
    : "";
  const listingTypeClause = options.listingType ? "AND publication_listings.listing_type = ?" : "";
  const rows = await db
    .prepare(
      `
      ${PUBLICATION_LISTING_VERSION_PROJECTION_CTE_SQL}
      SELECT
        publication_listings.id,
        publication_listings.listing_type AS type,
        publication_listings.target_plane AS targetPlane,
        publication_listings.target_id AS targetId,
        publication_listings.listed_version_id AS listedVersionId,
        publication_listings.review_version_id AS reviewVersionId,
        publication_listings.name,
        publication_listings.owner_alias_name AS ownerAliasName,
        publication_listings.created_by_user_id AS submittedById,
        submitted_by_users.name AS submittedByName,
        submitted_by_users.email AS submittedByEmail,
        ${userColumns.avatarUrl ? "COALESCE(submitted_by_users.avatar_url, '')" : "''"} AS submittedByAvatarUrl,
        submitted_by_teams.name AS submittedByTeam,
        submitted_by_profiles.department AS submittedByDepartment,
        submitted_by_profiles.job_title AS submittedByJobTitle,
        ${statusColumn} AS status,
        publication_listings.desired_status AS desiredStatus,
        publication_listings.effective_status AS effectiveStatus,
        publication_listings.publication_status AS authPublicationStatus,
        publication_listings.publication_error_code AS publicationErrorCode,
        publication_listings.visibility,
        publication_listings.home_display AS homeDisplay,
        publication_listings.risk_level AS riskLevel,
        publication_listings.review_notes AS reviewNotes,
        projected_publication_version.artifact_type AS artifactType,
        projected_publication_version.artifact_url AS artifactUrl,
        projected_publication_version.config_json AS configJson,
        publication_listings.summary,
        publication_listings.description,
        ${coverColumns.publicationListings ? "publication_listings.cover_image_url" : "''"} AS coverImageUrl,
        COALESCE(
          skill_categories.name,
          CASE publication_listings.listing_type
            WHEN 'app' THEN 'Workflow'
            WHEN 'mcp' THEN 'Coding'
            ELSE 'Research'
          END
        ) AS category,
        publication_listings.tags_json AS tagsJson,
        publication_listings.install_count AS installs,
        publication_listings.agent_add_count AS agentAddCount,
        publication_listings.zip_download_count AS downloadCount,
        publication_listings.visit_count AS visitCount,
        publication_listings.comment_count AS comments,
        publication_listings.rating,
        (
          SELECT COUNT(*)
          FROM publication_installations
          WHERE publication_installations.listing_id = publication_listings.id
            AND publication_installations.install_type = 'bookmark'
        ) AS likeCount,
        (
          SELECT COUNT(*)
          FROM publication_installations
          WHERE publication_installations.listing_id = publication_listings.id
            AND publication_installations.user_id = ?
            AND publication_installations.install_type = 'bookmark'
        ) AS likedByCurrentUser,
        publication_listings.updated_at AS updatedAt
      FROM publication_listing_projection AS publication_listings
      ${versionProjectionJoin}
      LEFT JOIN users AS submitted_by_users ON submitted_by_users.id = publication_listings.created_by_user_id
      LEFT JOIN teams AS submitted_by_teams ON submitted_by_teams.id = submitted_by_users.team_id
      LEFT JOIN user_identity_profiles AS submitted_by_profiles ON submitted_by_profiles.user_id = submitted_by_users.id
      LEFT JOIN skill_categories ON skill_categories.id = publication_listings.category_id
      WHERE ${statusColumn} != 'deleted'
        ${targetClause}
        ${listingTypeClause}
        AND (
          (
            COALESCE(publication_listings.target_plane, 'portal') != 'apps'
            AND publication_listings.created_by_user_id = ?
          )
          OR ? = 'admin'
          ${additionalAuthorClause}
          ${listedDiscoveryClause}
        )
      ORDER BY
        CASE publication_listings.listing_type
          WHEN 'app' THEN publication_listings.visit_count
          ELSE publication_listings.agent_add_count + publication_listings.zip_download_count
        END DESC,
        publication_listings.name
      `
    )
    .bind(
      currentUser.id,
      ...targetIds,
      ...(options.listingType ? [options.listingType] : []),
      currentUser.id,
      currentUser.role,
      ...authorizedListingIds
    )
    .all<Record<string, unknown>>();

  const listings = (rows.results ?? []).map(publicationListingFromRow);
  return options.attachOwnerProfiles === false
    ? listings
    : attachPublicationOwnerProfiles(db, listings, userColumns);
}

export async function attachPublicationOwnerProfiles(
  db: D1Database,
  listings: PortalCatalog["publicationListings"],
  userColumns: UserProfileColumns,
  ownerIdentifiersByListing?: ReadonlyMap<string, readonly string[]>
) {
  const identifiersByListing = new Map(listings.map((listing) => [
    listing.id,
    ownerIdentifiersByListing?.has(listing.id)
      ? uniqueOwnerIdentifiers(ownerIdentifiersByListing.get(listing.id) ?? [])
      : publicationOwnerIdentifiers(listing)
  ]));
  const identifiers = Array.from(new Set([...identifiersByListing.values()].flat().map(normalizeUserIdentifier).filter(Boolean))).slice(0, 200);

  if (identifiers.length === 0) {
    return listings;
  }

  const placeholders = identifiers.map(() => "?").join(", ");
  const users = await db
    .prepare(
      `
      SELECT
        users.id,
        users.name,
        users.email,
        ${userColumns.avatarUrl ? "COALESCE(users.avatar_url, '')" : "''"} AS avatarUrl,
        teams.name AS team,
        profiles.department,
        profiles.job_title AS jobTitle,
        journey.current_level_key AS journeyLevelKey,
        journey.total_points AS journeyTotalPoints,
        journey.community_contribution_points AS journeyCommunityContributionPoints
      FROM users
      LEFT JOIN teams ON teams.id = users.team_id
      LEFT JOIN user_identity_profiles AS profiles ON profiles.user_id = users.id
      LEFT JOIN portal_user_journey_state AS journey ON journey.user_id = users.id
      WHERE lower(users.id) IN (${placeholders})
         OR lower(users.email) IN (${placeholders})
      `
    )
    .bind(...identifiers, ...identifiers)
    .all<Record<string, unknown>>();
  const profileByIdentifier = new Map<string, NonNullable<PortalCatalog["publicationListings"][number]["submittedByProfile"]>>();

  for (const row of users.results ?? []) {
    const profile = assetUserProfileFromRow(row, "", String(row.id ?? ""));
    if (!profile) {
      continue;
    }
    profileByIdentifier.set(normalizeUserIdentifier(profile.id), profile);
    profileByIdentifier.set(normalizeUserIdentifier(profile.email), profile);
  }

  return listings.map((listing) => {
    const ownerProfiles = (identifiersByListing.get(listing.id) ?? []).map((identifier) => {
      const normalized = normalizeUserIdentifier(identifier);
      return profileByIdentifier.get(normalized) ?? {
        id: identifier,
        name: fallbackOwnerName(identifier),
        email: identifier.includes("@") ? identifier : ""
      };
    });

    return ownerProfiles.length > 0 ? { ...listing, ownerProfiles } : listing;
  });
}

function publicationOwnerIdentifiers(listing: PortalCatalog["publicationListings"][number]) {
  const config = listing.config ?? {};
  const builderSnapshot = readObject(config.builderSnapshot);
  const verified = readObject(builderSnapshot.appsVerified);
  const source = readObject(verified.app ?? verified.skill ?? builderSnapshot.app ?? builderSnapshot.skill);
  const ownerUserId = readText(source.ownerUserId ?? source.owner_user_id);
  const collaborators = Array.isArray(source.collaboratorUserIds ?? source.collaborator_user_ids)
    ? (source.collaboratorUserIds ?? source.collaborator_user_ids) as unknown[]
    : [];

  return uniqueOwnerIdentifiers([
    ownerUserId,
    ...collaborators.map(readText)
  ]);
}

function uniqueOwnerIdentifiers(values: readonly string[]) {
  const byNormalizedIdentifier = new Map<string, string>();
  for (const value of values) {
    const identifier = value.trim();
    const normalized = normalizeUserIdentifier(identifier);
    if (identifier && normalized && !byNormalizedIdentifier.has(normalized)) {
      byNormalizedIdentifier.set(normalized, identifier);
    }
  }
  return [...byNormalizedIdentifier.values()];
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readText(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function normalizeUserIdentifier(value: unknown) {
  return readText(value).trim().toLowerCase();
}

function fallbackOwnerName(value: string) {
  const localPart = value.includes("@") ? value.split("@")[0] : value;
  const words = localPart.split(/[._\-\s]+/).filter(Boolean);
  return words.length > 0
    ? words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ")
    : value;
}

export async function readSkills(db: D1Database, coverColumns: CatalogCoverColumns) {
  const rows = await db
    .prepare(
      `
      SELECT
        skills.id,
        skills.name,
        teams.name AS owner,
        COALESCE(skill_listing.status, skills.status) AS status,
        skills.description,
        skills.risk_level AS riskLevel,
        skills.review_notes AS reviewNotes,
        skills.rating,
        COALESCE(skill_categories.name, 'Research') AS category,
        ${coverColumns.skillCatalogMetadata ? "COALESCE(skill_catalog_metadata.cover_image_url, '')" : "''"} AS coverImageUrl,
        COALESCE(skill_catalog_metadata.kind, 'vanilla') AS kind,
        COALESCE(skill_catalog_metadata.current_version, '1.0.0') AS version,
        COALESCE(skill_catalog_metadata.install_count, 0) AS installs,
        COALESCE(skill_catalog_metadata.discussion_count, 0) AS discussions,
        COALESCE(skill_catalog_metadata.updated_at, skills.updated_at) AS updatedAt,
        COALESCE(group_concat(DISTINCT scopes.name), '') AS scopes,
        COALESCE(group_concat(DISTINCT mcp_tools.name), '') AS mcpTools,
        COALESCE(group_concat(DISTINCT dependency_servers.name), '') AS dependencies
      FROM skills
      JOIN teams ON teams.id = skills.owner_team_id
      LEFT JOIN publication_listings AS skill_listing
        ON skill_listing.listing_type = 'skill'
        AND skill_listing.target_plane = 'portal'
        AND skill_listing.target_id = skills.id
      LEFT JOIN skill_catalog_metadata ON skill_catalog_metadata.skill_id = skills.id
      LEFT JOIN skill_categories ON skill_categories.id = skill_catalog_metadata.category_id
      LEFT JOIN skill_scopes ON skill_scopes.skill_id = skills.id
      LEFT JOIN scopes ON scopes.id = skill_scopes.scope_id
      LEFT JOIN skill_mcp_tools ON skill_mcp_tools.skill_id = skills.id
      LEFT JOIN mcp_tools ON mcp_tools.id = skill_mcp_tools.tool_id
      LEFT JOIN skill_mcp_dependencies ON skill_mcp_dependencies.skill_id = skills.id
      LEFT JOIN mcp_servers AS dependency_servers ON dependency_servers.id = skill_mcp_dependencies.server_id
      WHERE COALESCE(skill_listing.status, skills.status) != 'deleted'
      GROUP BY skills.id
      ORDER BY installs DESC, skills.name
      `
    )
    .all<Record<string, unknown>>();

  return (rows.results ?? []).map(skillFromRow);
}

export async function readDataServices(db: D1Database) {
  const rows = await db
    .prepare(
      `
      SELECT
        mcp_servers.id,
        mcp_servers.name,
        teams.name AS owner,
        mcp_servers.status,
        mcp_servers.endpoint_url AS endpoint,
        CASE
          WHEN mcp_servers.risk_level = 'high' OR SUM(CASE WHEN mcp_tools.risk_level = 'high' THEN 1 ELSE 0 END) > 0 THEN 'high'
          WHEN mcp_servers.risk_level = 'medium' OR SUM(CASE WHEN mcp_tools.risk_level = 'medium' THEN 1 ELSE 0 END) > 0 THEN 'medium'
          ELSE 'low'
        END AS risk,
        mcp_servers.review_notes AS reviewNotes,
        CASE mcp_servers.id
          WHEN 'mcp-legal' THEN 'Trusted legal document extraction, clause comparison, and risk reporting service.'
          WHEN 'mcp-crm' THEN 'CRM and support context service for account brief generation.'
          WHEN 'mcp-platform' THEN 'Release, deployment, and incident metadata service for platform Builders.'
          ELSE 'Internal data and MCP service available to Builders.'
        END AS description,
        CASE mcp_servers.id
          WHEN 'mcp-crm' THEN '5 min'
          ELSE 'Live'
        END AS freshness,
        CASE mcp_servers.id
          WHEN 'mcp-legal' THEN 18240
          WHEN 'mcp-crm' THEN 26410
          WHEN 'mcp-platform' THEN 7312
          ELSE 1000
        END AS monthlyCalls,
        COALESCE(group_concat(DISTINCT scopes.name), '') AS scopes,
        COALESCE(group_concat(DISTINCT mcp_tools.name), '') AS tools,
        COALESCE(group_concat(DISTINCT skills.name), '') AS boundSkills
      FROM mcp_servers
      JOIN teams ON teams.id = mcp_servers.owner_team_id
      LEFT JOIN mcp_tools ON mcp_tools.server_id = mcp_servers.id
      LEFT JOIN mcp_tool_scopes ON mcp_tool_scopes.tool_id = mcp_tools.id
      LEFT JOIN scopes ON scopes.id = mcp_tool_scopes.scope_id
      LEFT JOIN skill_mcp_tools ON skill_mcp_tools.tool_id = mcp_tools.id
      LEFT JOIN skills ON skills.id = skill_mcp_tools.skill_id
      WHERE mcp_servers.status != 'deleted'
      GROUP BY mcp_servers.id
      ORDER BY monthlyCalls DESC, mcp_servers.name
      `
    )
    .all<Record<string, unknown>>();

  return (rows.results ?? []).map(dataServiceFromRow);
}

export async function readApps(
  db: D1Database,
  userColumns: UserProfileColumns,
  coverColumns: CatalogCoverColumns,
  targetIds: string[] = [],
  options: { statusSource?: "app" | "effective_publication" } = {}
) {
  const selectedTargetIds = Array.from(new Set(targetIds.map((targetId) => targetId.trim()).filter(Boolean))).slice(0, 24);
  const readsAppStatus = options.statusSource === "app";
  const statusExpression = readsAppStatus ? "apps.status" : "COALESCE(app_listing.status, apps.status)";
  const statement = db.prepare(
    `
      SELECT
        apps.id,
        apps.name,
        apps.name_zh AS nameZh,
        apps.name_en AS nameEn,
        apps.subtitle,
        apps.app_type AS appType,
        COALESCE(apps.publisher_user_id, '') AS publisherId,
        publisher_users.name AS publisherName,
        publisher_users.email AS publisherEmail,
        ${userColumns.avatarUrl ? "COALESCE(publisher_users.avatar_url, '')" : "''"} AS publisherAvatarUrl,
        publisher_teams.name AS publisherTeam,
        publisher_profiles.department AS publisherDepartment,
        publisher_profiles.job_title AS publisherJobTitle,
        ${statusExpression} AS status,
        apps.description,
        apps.description_zh AS descriptionZh,
        apps.description_en AS descriptionEn,
        ${coverColumns.appCatalogMetadata ? "COALESCE(app_catalog_metadata.cover_image_url, '')" : "''"} AS coverImageUrl,
        apps.sdk_status AS sdkStatus,
        apps.launch_url AS launchUrl,
        apps.callback_url AS callbackUrl,
        COALESCE(skill_categories.name, 'Workflow') AS category,
        apps.model,
        apps.model_provider AS modelProvider,
        apps.deployment_type AS deploymentType,
        apps.deployment_provider AS deploymentProvider,
        apps.deployment_method AS deploymentMethod,
        apps.data_region AS dataRegion,
        apps.data_types_json AS dataTypesJson,
        apps.sensitive_data_json AS sensitiveDataJson,
        apps.knowledge_sources_json AS knowledgeSourcesJson,
        apps.user_scope AS userScope,
        apps.access_mode AS accessMode,
        apps.access_targets_json AS accessTargetsJson,
        apps.uses_workspace_auth AS usesWorkspaceAuth,
        apps.risk_level AS riskLevel,
        apps.risk_reason AS riskReason,
        apps.permission_notes AS permissionNotes,
        apps.output_notes AS outputNotes,
        apps.review_notes AS reviewNotes,
        apps.current_version AS version,
        apps.changelog,
        apps.listed_at AS listedAt,
        apps.delisted_at AS delistedAt,
        COALESCE(app_catalog_metadata.tags_json, '[]') AS tagsJson,
        COALESCE(app_catalog_metadata.screenshots_json, '[]') AS screenshotsJson,
        COALESCE(app_catalog_metadata.view_count, 0) AS viewCount,
        COALESCE(app_catalog_metadata.launch_count, 0) AS launchCount,
        COALESCE(app_catalog_metadata.download_count, 0) AS downloadCount,
        COALESCE(app_catalog_metadata.like_count, 0) AS likeCount,
        COALESCE(app_catalog_metadata.favorite_count, 0) AS favoriteCount,
        COALESCE(app_catalog_metadata.rating, 0) AS rating,
        COALESCE(app_catalog_metadata.rating_count, 0) AS ratingCount,
        COALESCE(app_catalog_metadata.discussion_count, 0) AS discussionCount,
        COALESCE(app_catalog_metadata.active_user_count, app_catalog_metadata.monthly_users, 0) AS activeUserCount,
        COALESCE(app_catalog_metadata.updated_at, apps.updated_at) AS updatedAt,
        COALESCE(app_catalog_metadata.monthly_users, 0) AS monthlyUsers,
        COALESCE(group_concat(DISTINCT scopes.name), '') AS scopes
      FROM apps
      ${readsAppStatus ? "" : `LEFT JOIN publication_listings AS app_listing
        ON app_listing.listing_type = 'app'
        AND app_listing.target_plane = 'portal'
        AND app_listing.target_id = apps.id`}
      LEFT JOIN users AS publisher_users ON publisher_users.id = apps.publisher_user_id
      LEFT JOIN teams AS publisher_teams ON publisher_teams.id = publisher_users.team_id
      LEFT JOIN user_identity_profiles AS publisher_profiles ON publisher_profiles.user_id = publisher_users.id
      LEFT JOIN app_catalog_metadata ON app_catalog_metadata.app_id = apps.id
      LEFT JOIN skill_categories ON skill_categories.id = app_catalog_metadata.category_id
      LEFT JOIN app_scopes ON app_scopes.app_id = apps.id
      LEFT JOIN scopes ON scopes.id = app_scopes.scope_id
      WHERE ${statusExpression} != 'deleted'
        ${selectedTargetIds.length > 0 ? `AND apps.id IN (${selectedTargetIds.map(() => "?").join(", ")})` : ""}
      GROUP BY apps.id
      ORDER BY monthlyUsers DESC, apps.name
      `
  );
  const rows = selectedTargetIds.length > 0
    ? await statement.bind(...selectedTargetIds).all<Record<string, unknown>>()
    : await statement.all<Record<string, unknown>>();

  return (rows.results ?? []).map(appFromRow);
}

export async function readCurrentApp(
  db: D1Database,
  userColumns: UserProfileColumns,
  coverColumns: CatalogCoverColumns,
  appId: string
) {
  const normalizedAppId = appId.trim();
  if (!normalizedAppId) {
    return undefined;
  }

  return (await readApps(db, userColumns, coverColumns, [normalizedAppId], { statusSource: "app" }))[0];
}

export async function readUsageSummary(db: D1Database, currentUser: CurrentUser): Promise<PortalCatalog["usage"] | undefined> {
  return (await db
    .prepare(
      `
      SELECT
        quota_limit AS quotaLimit,
        quota_used AS quotaUsed,
        reset_date AS resetDate,
        api_keys AS apiKeys,
        active_tokens AS activeTokens,
        last_token_refresh AS lastTokenRefresh
      FROM user_usage
      WHERE user_id = ?
      LIMIT 1
      `
    )
    .bind(currentUser.id)
    .first<PortalCatalog["usage"]>()) ?? undefined;
}

export async function readMcpTools(db: D1Database) {
  const rows = await db
    .prepare(
      `
      SELECT
        mcp_tools.id,
        mcp_servers.name AS server,
        mcp_tools.name,
        mcp_tools.risk_level AS risk,
        COALESCE(group_concat(DISTINCT scopes.name), '') AS scopes,
        COALESCE(MAX(skills.name), 'Unbound') AS boundSkill
      FROM mcp_tools
      JOIN mcp_servers ON mcp_servers.id = mcp_tools.server_id
      LEFT JOIN mcp_tool_scopes ON mcp_tool_scopes.tool_id = mcp_tools.id
      LEFT JOIN scopes ON scopes.id = mcp_tool_scopes.scope_id
      LEFT JOIN skill_mcp_tools ON skill_mcp_tools.tool_id = mcp_tools.id
      LEFT JOIN skills ON skills.id = skill_mcp_tools.skill_id
      GROUP BY mcp_tools.id
      ORDER BY mcp_servers.name, mcp_tools.name
      `
    )
    .all<Record<string, unknown>>();

  return (rows.results ?? []).map(mcpToolFromRow);
}

export async function readAuditEvents(db: D1Database) {
  const rows = await db
    .prepare(
      `
      SELECT
        id,
        actor_id AS actor,
        action,
        target_id AS target,
        created_at AS time
      FROM audit_logs
      ORDER BY created_at DESC
      LIMIT 10
      `
    )
    .all();

  return rows.results ?? [];
}

export async function readReviewQueue(db: D1Database) {
  const rows = await db
    .prepare(
      `
      SELECT
        review_queue.id,
        review_queue.item_type AS type,
        review_queue.title,
        teams.name AS owner,
        review_queue.risk_level AS risk,
        review_queue.submitted_at AS submittedAt
      FROM review_queue
      JOIN teams ON teams.id = review_queue.owner_team_id
      WHERE review_queue.status = 'open'
      ORDER BY review_queue.submitted_at DESC
      LIMIT 20
      `
    )
    .all();

  return rows.results ?? [];
}

export async function readActivity(db: D1Database, currentUser: CurrentUser, env: CatalogEnv, deps: CatalogDeps<CatalogEnv>) {
  return readActivityEvents(db, currentUser, { env, limit: MAX_ACTIVITY_EVENT_LIMIT }, deps);
}

export async function readJourney(db: D1Database, currentUser: CurrentUser) {
  return readPortalJourney(db, currentUser);
}
