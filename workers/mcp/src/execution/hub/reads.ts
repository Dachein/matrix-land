import { readString } from "../../http.ts";
import { filterHubListingsForPrincipal } from "../../hubAccess.ts";
import { type Env, HttpError, type Principal } from "../../types.ts";
import { callAppsWorker } from "../clients/apps.ts";
import { boundedLimit, escapeLike, mcpToolPayload, readOptionalString, readRecord, safeJsonArray, safeJsonRecord } from "../values.ts";
import { readLatestHubListingVersion } from "./repository.ts";
import { withoutHubPolicyFields } from "./representation.ts";

export async function searchHubListings(env: Env, principal: Principal, args: Record<string, unknown>, forcedTypes?: string[]) {
  const db = env.DB;
  const limit = boundedLimit(args.limit);
  const query = readString(args.q).trim();
  const type = readString(args.type).trim();
  const filters: string[] = ["publication_listings.effective_status = 'listed'"];
  const binds: unknown[] = [];

  if (query) {
    filters.push("(lower(publication_listings.name) LIKE ? ESCAPE '\\' OR lower(publication_listings.summary) LIKE ? ESCAPE '\\' OR lower(publication_listings.description) LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLike(query.toLowerCase())}%`;
    binds.push(pattern, pattern, pattern);
  }

  if (forcedTypes?.length) {
    filters.push(`publication_listings.listing_type IN (${forcedTypes.map(() => "?").join(", ")})`);
    binds.push(...forcedTypes);
  } else if (type === "skill" || type === "app") {
    filters.push("publication_listings.listing_type = ?");
    binds.push(type);
  }

  const rows = await db
    .prepare(
      `
      SELECT
        publication_listings.id,
        publication_listings.listing_type AS type,
        publication_listings.target_plane AS targetPlane,
        publication_listings.target_id AS targetId,
        publication_listings.name,
        publication_listings.summary,
        publication_listings.description,
        publication_listings.effective_status AS status,
        publication_listings.visibility,
        publication_listings.risk_level AS riskLevel,
        publication_listings.install_count AS installs,
        publication_listings.comment_count AS comments,
        publication_listings.rating,
        publication_listings.cover_image_url AS coverImageUrl,
        publication_listings.updated_at AS updatedAt,
        (
          SELECT publication_versions.config_json
          FROM publication_versions
          WHERE publication_versions.listing_id = publication_listings.id
          ORDER BY publication_versions.created_at DESC
          LIMIT 1
        ) AS configJson,
        COALESCE(NULLIF(publisher_users.name, ''), publisher_users.email, publication_listings.created_by_user_id) AS owner,
        COALESCE(
          skill_categories.name,
          CASE publication_listings.listing_type
            WHEN 'app' THEN 'Workflow'
            WHEN 'mcp' THEN 'Coding'
            ELSE 'Research'
          END
        ) AS category
      FROM publication_listings
      LEFT JOIN users AS publisher_users ON publisher_users.id = publication_listings.created_by_user_id
      LEFT JOIN skill_categories ON skill_categories.id = publication_listings.category_id
      WHERE ${filters.join(" AND ")}
      ORDER BY publication_listings.install_count DESC, publication_listings.updated_at DESC
      `
    )
    .bind(...binds)
    .all<Record<string, unknown>>();
  const accessible = await filterHubListingsForPrincipal(rows.results ?? [], env, principal);
  return accessible.slice(0, limit).map(withoutHubPolicyFields);
}

export async function getHubListing(env: Env, principal: Principal, listingId: string) {
  const db = env.DB;
  const listing = await db
    .prepare(
      `
      SELECT
        publication_listings.id,
        publication_listings.listing_type AS type,
        publication_listings.target_plane AS targetPlane,
        publication_listings.target_id AS targetId,
        publication_listings.name,
        publication_listings.summary,
        publication_listings.description,
        publication_listings.effective_status AS status,
        publication_listings.visibility,
        publication_listings.risk_level AS riskLevel,
        publication_listings.install_count AS installs,
        publication_listings.comment_count AS comments,
        publication_listings.rating,
        publication_listings.tags_json AS tagsJson,
        publication_listings.cover_image_url AS coverImageUrl,
        publication_listings.updated_at AS updatedAt,
        (
          SELECT publication_versions.config_json
          FROM publication_versions
          WHERE publication_versions.listing_id = publication_listings.id
          ORDER BY publication_versions.created_at DESC
          LIMIT 1
        ) AS configJson,
        COALESCE(NULLIF(publisher_users.name, ''), publisher_users.email, publication_listings.created_by_user_id) AS owner,
        COALESCE(
          skill_categories.name,
          CASE publication_listings.listing_type
            WHEN 'app' THEN 'Workflow'
            WHEN 'mcp' THEN 'Coding'
            ELSE 'Research'
          END
        ) AS category
      FROM publication_listings
      LEFT JOIN users AS publisher_users ON publisher_users.id = publication_listings.created_by_user_id
      LEFT JOIN skill_categories ON skill_categories.id = publication_listings.category_id
      WHERE publication_listings.id = ? AND publication_listings.effective_status = 'listed'
      LIMIT 1
      `
    )
    .bind(listingId)
    .first<Record<string, unknown>>();

  if (!listing) {
    throw new HttpError(404, "hub_listing_not_found");
  }
  const [accessibleListing] = await filterHubListingsForPrincipal([listing], env, principal);
  if (!accessibleListing) {
    throw new HttpError(404, "hub_listing_not_found");
  }

  const versions = await db
    .prepare(
      `
      SELECT id, version, artifact_type AS artifactType, artifact_url AS artifactUrl, changelog, created_at AS createdAt
      FROM publication_versions
      WHERE listing_id = ?
      ORDER BY created_at DESC
      LIMIT 10
      `
    )
    .bind(listingId)
    .all<Record<string, unknown>>();

  return {
    ...withoutHubPolicyFields(accessibleListing),
    tags: safeJsonArray(accessibleListing.tagsJson),
    tagsJson: undefined,
    versions: versions.results ?? []
  };
}

export async function downloadHubSkillPackage(env: Env, principal: Principal, args: Record<string, unknown>) {
  const listingRef = await resolveHubSkillListing(env, principal, args);
  const client = readString(args.client) || "codex";
  const result = await callAppsWorker(env, {
    sub: "hub-listing-download",
    scopes: []
  }, "/mcp", {
    appsScopes: ["apps:skills:read"],
    method: "POST",
    rpcMethod: "tools/call",
    rpcName: "apps_download_skill_package",
    rpcArgs: {
      client,
      skillId: listingRef.skillId,
      version: listingRef.versionId
    },
    tokenType: "publication_access",
    skillId: listingRef.skillId,
    listingId: listingRef.listingId
  });
  const payload = mcpToolPayload(result);
  const packagePayload = readRecord(payload.package);

  return {
    ...payload,
    hub: {
      listingId: listingRef.listingId,
      listingName: listingRef.name,
      latestVersion: readOptionalString(packagePayload.version) ?? listingRef.latestVersion,
      publicationVersionId: listingRef.publicationVersionId,
      versionId: listingRef.versionId
    }
  };
}

async function resolveHubSkillListing(env: Env, principal: Principal, args: Record<string, unknown>) {
  const db = env.DB;
  const listingId = readString(args.listingId).trim();
  const skillId = readString(args.skillId).trim();

  if (!listingId && !skillId) {
    throw new HttpError(400, "missing_hub_skill_listing");
  }

  const listing = await db
    .prepare(
      `
      SELECT
        publication_listings.id,
        publication_listings.name,
        publication_listings.listing_type AS type,
        publication_listings.target_plane AS targetPlane,
        publication_listings.target_id AS targetId,
        publication_listings.target_id AS skillId,
        publication_listings.visibility,
        (
          SELECT publication_versions.config_json
          FROM publication_versions
          WHERE publication_versions.listing_id = publication_listings.id
          ORDER BY publication_versions.created_at DESC
          LIMIT 1
        ) AS configJson
      FROM publication_listings
      WHERE status = 'listed'
        AND target_plane = 'apps'
        AND listing_type = 'skill'
        AND (
          (? != '' AND id = ?)
          OR (? != '' AND target_id = ?)
        )
      LIMIT 1
      `
    )
    .bind(listingId, listingId, skillId, skillId)
    .first<Record<string, unknown>>();

  if (!listing) {
    throw new HttpError(404, "hub_skill_listing_not_found");
  }
  const [accessibleListing] = await filterHubListingsForPrincipal([listing], env, principal);
  if (!accessibleListing) {
    throw new HttpError(404, "hub_skill_listing_not_found");
  }

  const version = await readLatestHubListingVersion(db, readString(accessibleListing.id));
  const config = safeJsonRecord(version.configJson);
  const appsVerification = readRecord(config.appsVerification);
  const snapshotVersion = readRecord(readRecord(readRecord(config.builderSnapshot).appsVerified).version);
  const latestVersion = readString(version.version).trim();
  const versionId = readOptionalString(config.versionId)
    ?? readOptionalString(appsVerification.versionId)
    ?? readOptionalString(snapshotVersion.id)
    ?? latestVersion;

  if (!versionId) {
    throw new HttpError(404, "hub_skill_version_not_found");
  }

  return {
    listingId: readString(accessibleListing.id),
    latestVersion,
    publicationVersionId: readString(version.id),
    name: readString(accessibleListing.name),
    skillId: readString(accessibleListing.skillId),
    versionId
  };
}
