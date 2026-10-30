import { missingConfiguration } from "../../../../../src/shared/requiredConfiguration.ts";
import { restoreCatalogImageSource } from "../../../../../src/shared/catalogImageReference.ts";
import { normalizeMarketCategoryName } from "../../../../../src/shared/marketCategories.ts";
import { readString } from "../../http.ts";
import { type Env, HttpError, type Principal } from "../../types.ts";
import { ensureForumUser } from "../forum/identity.ts";
import { excerpt, sanitizeTags } from "../forum/topics.ts";
import { optionalText, readOptionalString, readRecord, requireArg, requireText, shortId } from "../values.ts";
import { normalizeHubArtifactType, normalizeHubRiskLevel, normalizeHubVisibility } from "./input.ts";
import { auditHubSubmission, ensureHubCategory, uniqueHubPublicationVersion, uniqueHubSlug } from "./repository.ts";
import { normalizeAssetImageUrlForHub } from "./representation.ts";
import { readAppsHubSubmissionSource } from "./source.ts";
import type { HubSubmissionTargetType } from "./types.ts";

export async function submitHubListing(env: Env, args: Record<string, unknown>, principal: Principal, toolName: string) {
  const targetType = hubSubmissionTargetType(toolName, args);
  const targetId = requireArg(args.targetId || (targetType === "app" ? args.appId : args.skillId), "missing_target_id");
  const requestedVersion = readOptionalString(args.version) ?? readOptionalString(args.versionId);
  const source = await readAppsHubSubmissionSource(env, principal, targetType, targetId, requestedVersion);
  const user = await ensureForumUser(env, principal);
  const name = requireText(readOptionalString(args.name) ?? source.defaultName, "missing_listing_name", 160);
  const description = requireText(readOptionalString(args.description) ?? source.defaultDescription, "missing_listing_description", 3000);
  const summary = optionalText(args.summary, 500) || source.defaultSummary || excerpt(description);
  const riskLevel = normalizeHubRiskLevel(args.riskLevel);
  const visibility = normalizeHubVisibility(readOptionalString(args.visibility) ?? source.defaultVisibility);
  const categoryId = await ensureHubCategory(env.DB, normalizeMarketCategoryName(args.category ?? source.defaultCategory, targetType === "app" ? "workflow" : "research"));
  const submittedTags = sanitizeTags(args.tags);
  const tags = submittedTags.length > 0 ? submittedTags : source.defaultTags;
  const existing = await env.DB
    .prepare(
      `
      SELECT id, slug, cover_image_url AS coverImageUrl
      FROM publication_listings
      WHERE listing_type = ? AND target_id = ?
      LIMIT 1
      `
    )
    .bind(targetType, targetId)
    .first<{ id: string; slug: string; coverImageUrl?: string }>();
  const coverImageUrl = normalizeAssetImageUrlForHub(args.coverImageUrl === undefined
    ? existing?.coverImageUrl
    : restoreCatalogImageSource(targetType, targetId, args.coverImageUrl, existing?.coverImageUrl,
        env.PORTAL_URL ?? missingConfiguration("PORTAL_URL")));

  if (targetType === "app" && !coverImageUrl) {
    throw new HttpError(400, "missing_cover_image_url");
  }

  const listingId = existing?.id ?? `listing-${targetType}-${shortId()}-${shortId()}`;
  const slug = existing?.slug ?? await uniqueHubSlug(env.DB, name);
  const version = await uniqueHubPublicationVersion(env.DB, listingId, (source.version ?? requestedVersion ?? `submission-${Date.now()}`).slice(0, 80));
  const versionId = source.versionId ?? readOptionalString(args.versionId) ?? version;
  const publicationVersionId = `market-version-${shortId()}-${shortId()}`;
  const builderSnapshot = {
    ...readRecord(args.builderSnapshot),
    appsVerified: source.builderSnapshot
  };
  const overviewMarkdown = optionalText(args.overviewMarkdown, 200000);
  const config = {
    ...readRecord(args.config),
    ...(overviewMarkdown ? { overviewMarkdown } : {}),
    source: "workspace-mcp",
    targetPlane: "apps",
    targetType,
    targetId,
    versionId,
    appsVerification: source.verification,
    builderSnapshot
  };
  const artifactType = normalizeHubArtifactType(args.artifactType, targetType);
  const artifactUrl = targetType === "skill"
    ? `/api/listings/${encodeURIComponent(listingId)}/download`
    : (source.artifactUrl ?? readOptionalString(args.artifactUrl))?.slice(0, 1200) ?? null;
  const artifactBody = optionalText(args.artifactBody, 200000);
  const changelog = optionalText(args.changelog, 1200) || "Submitted from Workspace MCP.";
  const statements: D1PreparedStatement[] = [];

  if (existing) {
    statements.push(
      env.DB
        .prepare(
          `
          UPDATE publication_listings
          SET target_plane = 'apps',
              review_version_id = ?,
              name = ?,
              summary = ?,
              description = ?,
              cover_image_url = ?,
              category_id = ?,
              tags_json = ?,
              status = 'pending_review',
              visibility = ?,
              risk_level = ?,
              builder_snapshot_json = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `
        )
        .bind(versionId, name, summary, description, coverImageUrl, categoryId, JSON.stringify(tags), visibility, riskLevel, JSON.stringify(builderSnapshot), listingId)
    );
  } else {
    statements.push(
      env.DB
        .prepare(
          `
          INSERT INTO publication_listings (
            id,
            listing_type,
            target_plane,
            target_id,
            review_version_id,
            created_by_user_id,
            name,
            slug,
            summary,
            description,
            cover_image_url,
            category_id,
            tags_json,
            status,
            visibility,
            risk_level,
            builder_snapshot_json
          )
          VALUES (?, ?, 'apps', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?)
          `
        )
        .bind(listingId, targetType, targetId, versionId, user.id, name, slug, summary, description, coverImageUrl, categoryId, JSON.stringify(tags), visibility, riskLevel, JSON.stringify(builderSnapshot))
    );
  }

  statements.push(
    env.DB
      .prepare(
        `
        INSERT INTO publication_versions (
          id,
          listing_id,
          version,
          artifact_type,
          artifact_url,
          artifact_body,
          config_json,
          changelog,
          created_by_user_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(publicationVersionId, listingId, version, artifactType, artifactUrl, artifactBody, JSON.stringify(config), changelog, user.id),
    env.DB
      .prepare(
        `
        INSERT INTO review_queue (id, item_type, title, owner_team_id, risk_level, status, submitted_at)
        VALUES (?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP)
        `
      )
      .bind(`review-${shortId()}-${shortId()}`, targetType, name, user.teamId || "team-ai-adoption", riskLevel)
  );

  await env.DB.batch(statements);
  await auditHubSubmission(env.DB, user.id, listingId, {
    coverImage: Boolean(coverImageUrl),
    targetId,
    targetPlane: "apps",
    targetType,
    version,
    versionId
  });

  return {
    listingId,
    publicationVersionId,
    status: "pending_review",
    targetId,
    targetPlane: "apps",
    targetType,
    version
  };
}

function hubSubmissionTargetType(toolName: string, args: Record<string, unknown>): HubSubmissionTargetType {
  if (toolName === "hub_submit_app") {
    return "app";
  }
  if (toolName === "hub_submit_skill") {
    return "skill";
  }

  return readString(args.targetType).trim() === "app" ? "app" : "skill";
}
