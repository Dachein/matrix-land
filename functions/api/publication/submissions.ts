import { restoreCatalogImageSource } from "../../../src/shared/catalogImageReference.ts";
import type { PortalCatalog } from "../../../src/shared/types.ts";
import { normalizeMarketCategoryName } from "../../../src/shared/marketCategories.ts";
import { normalizeSkillProductKind } from "../../../src/shared/skillTaxonomy.ts";
import {
  WORKSPACE_RELEASE_READINESS_REPORT_NAME,
  WORKSPACE_RELEASE_READINESS_REPORT_SCHEMA,
  workspaceHarnessReportUrl,
  isWorkspaceHarnessReportUrl,
  isReleaseReadinessReportRequired
} from "../../../src/shared/harnessReport.ts";
import type { AppsPublicationSource } from "./appsSource.ts";
import type { PublicationSubmissionTargetType } from "./normalizers.ts";
import {
  normalizeAssetRiskLevel,
  normalizeListingType,
  normalizePublicationArtifactType,
  normalizePublicationVisibility,
  normalizeTargetPlane,
  normalizeUnknownObject,
  normalizeVersion
} from "./normalizers.ts";

type CurrentUser = PortalCatalog["currentUser"];

type PublicationSubmissionsEnv = {
  DB?: D1Database;
  DEFAULT_TEAM_ID?: string;
  WORKSPACE_RELEASE_READINESS_REPORT_REQUIRED?: string;
};

type PublicationSubmissionsContext<TEnv extends PublicationSubmissionsEnv> = EventContext<TEnv, string, unknown>;

export type PublicationSubmissionInput = {
  artifactBody?: string;
  artifactType?: string;
  artifactUrl?: string;
  builderSnapshot?: unknown;
  category?: string;
  changelog?: string;
  config?: unknown;
  coverImageUrl?: string;
  description?: string;
  descriptionMarkdown?: string;
  harnessReportUrl?: string;
  harnessSelfCheckConfirmed?: boolean;
  name?: string;
  overviewMarkdown?: string;
  riskLevel?: string;
  summary?: string;
  tags?: unknown;
  targetId?: string;
  targetPlane?: string;
  targetType?: string;
  version?: string;
  versionId?: string;
  visibility?: string;
};

type CatalogCoverColumns = {
  appCatalogMetadata?: boolean;
  publicationListings?: boolean;
  skillCatalogMetadata?: boolean;
};

type PublicationSubmissionsDeps<TEnv extends PublicationSubmissionsEnv> = {
  audit(
    db: D1Database,
    actorType: string,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata?: Record<string, unknown>
  ): Promise<string>;
  catalogCoverColumns(db: D1Database): Promise<CatalogCoverColumns>;
  currentUserTeamId(db: D1Database, currentUser: CurrentUser, env: TEnv): Promise<string>;
  ensureCategory(db: D1Database, value: string): Promise<string>;
  excerpt(value: string): string;
  httpError(status: number, message: string): Error;
  normalizeAssetImageUrl(value: unknown): string;
  normalizeCoverImageUrl(value: unknown): string;
  optionalText(value: unknown, maxLength: number): string;
  readBody<T>(request: Request): Promise<T>;
  readAppsPublicationSource(
    context: PublicationSubmissionsContext<TEnv>,
    currentUser: CurrentUser,
    targetType: PublicationSubmissionTargetType,
    targetId: string,
    requestedVersion?: string
  ): Promise<AppsPublicationSource>;
  requireDb(db: D1Database | undefined): D1Database;
  requireText(value: unknown, errorCode: string, maxLength: number): string;
  resolveCurrentUser(context: PublicationSubmissionsContext<TEnv>): Promise<CurrentUser>;
  sanitizeTags(value: unknown): string[];
  shortId(): string;
  uniquePublicationVersion(db: D1Database, listingId: string, value: string): Promise<string>;
  uniqueSlug(db: D1Database, value: string): Promise<string>;
};

export function createPublicationSubmissionsApi<TEnv extends PublicationSubmissionsEnv>(deps: PublicationSubmissionsDeps<TEnv>) {
  return {
    async createSkillListing(context: PublicationSubmissionsContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<{
        name?: string;
        description?: string;
        kind?: string;
        category?: string;
        coverImageUrl?: string;
        tags?: string[];
        skillMarkdown?: string;
        version?: string;
      }>(context.request);
      const name = deps.requireText(body.name, "missing_skill_name", 120);
      const description = deps.requireText(body.description, "missing_skill_description", 800);
      const kind = normalizeSkillProductKind(body.kind);
      const version = normalizeVersion(body.version);
      const skillMarkdown = readOptionalString(body.skillMarkdown) ?? description;
      const coverImageUrl = deps.normalizeCoverImageUrl(body.coverImageUrl);
      const tags = deps.sanitizeTags(body.tags);
      const teamId = await deps.currentUserTeamId(db, currentUser, context.env);
      const categoryId = await deps.ensureCategory(db, normalizeMarketCategoryName(body.category, "research"));
      const coverColumns = await deps.catalogCoverColumns(db);
      const slug = await deps.uniqueSlug(db, name);
      const skillId = `skill-${slug}-${deps.shortId()}`;
      const listingId = `listing-${skillId}`;
      const versionId = `version-${skillId}-${version.replaceAll(".", "-")}`;
      const now = new Date().toISOString();
      const skillMetadataStatement = coverColumns.skillCatalogMetadata
        ? db
            .prepare(
              `
              INSERT INTO skill_catalog_metadata (skill_id, category_id, kind, current_version, cover_image_url, install_count, discussion_count, updated_at)
              VALUES (?, ?, ?, ?, ?, 0, 0, CURRENT_TIMESTAMP)
              `
            )
            .bind(skillId, categoryId, kind, version, coverImageUrl)
        : db
            .prepare(
              `
              INSERT INTO skill_catalog_metadata (skill_id, category_id, kind, current_version, install_count, discussion_count, updated_at)
              VALUES (?, ?, ?, ?, 0, 0, CURRENT_TIMESTAMP)
              `
            )
            .bind(skillId, categoryId, kind, version);
      const publicationListingStatement = coverColumns.publicationListings
        ? db
            .prepare(
              `
              INSERT INTO publication_listings (
                id,
                listing_type,
                target_id,
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
                published_at
              )
              VALUES (?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', 'org', NULL)
              `
            )
            .bind(listingId, skillId, currentUser.id, name, slug, deps.excerpt(description), description, coverImageUrl, categoryId, JSON.stringify(tags))
        : db
            .prepare(
              `
              INSERT INTO publication_listings (
                id,
                listing_type,
                target_id,
                created_by_user_id,
                name,
                slug,
                summary,
                description,
                category_id,
                tags_json,
                status,
                visibility,
                published_at
              )
              VALUES (?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', 'org', NULL)
              `
            )
            .bind(listingId, skillId, currentUser.id, name, slug, deps.excerpt(description), description, categoryId, JSON.stringify(tags));

      await db.batch([
        db
          .prepare(
            `
            INSERT INTO skills (id, owner_team_id, name, slug, description, sop_markdown, status, visibility, rating, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending_review', 'internal', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `
          )
          .bind(skillId, teamId, name, slug, description, skillMarkdown),
        skillMetadataStatement,
        db
          .prepare(
            `
            INSERT INTO skill_versions (id, skill_id, version, changelog, artifact_type)
            VALUES (?, ?, ?, 'Initial publication publish.', ?)
            `
          )
          .bind(versionId, skillId, version, "skill_md"),
        publicationListingStatement,
        db
          .prepare(
            `
            INSERT INTO publication_versions (id, listing_id, version, artifact_type, artifact_body, changelog, created_by_user_id)
            VALUES (?, ?, ?, 'skill_md', ?, 'Initial publication publish.', ?)
            `
          )
          .bind(`listing-${versionId}`, listingId, version, skillMarkdown, currentUser.id)
      ]);

      await deps.audit(db, "user", currentUser.id, "submitted skill for review", "publication_listing", listingId, {
        skillId,
        kind,
        version,
        hasCoverImage: coverImageUrl.length > 0,
        tags,
        submittedAt: now
      });

      return {
        listingId,
        skillId,
        version,
        status: "pending_review"
      };
    },

    async createPublicationSubmission(context: PublicationSubmissionsContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<PublicationSubmissionInput>(context.request);
      const targetType = normalizeListingType(body.targetType);
      const targetPlane = normalizeTargetPlane(body.targetPlane);
      const targetId = deps.requireText(body.targetId, "missing_target_id", 160);
      const requestedVersionInput = readOptionalString(body.version) ?? readOptionalString(body.versionId);
      const appsSource = targetPlane === "apps"
        ? await deps.readAppsPublicationSource(context, currentUser, targetType, targetId, requestedVersionInput)
        : undefined;
      const releaseReadiness = targetPlane === "apps" && targetType === "app"
        ? resolveAppsAppReleaseReadiness(
            body,
            appsSource,
            isReleaseReadinessReportRequired(context.env.WORKSPACE_RELEASE_READINESS_REPORT_REQUIRED),
            deps.httpError
          )
        : undefined;
      const requestedVersion = appsSource?.version ?? requestedVersionInput ?? `submission-${Date.now()}`;
      const name = deps.requireText(body.name, "missing_listing_name", 160);
      const description = deps.requireText(body.description, "missing_listing_description", 3000);
      const summary = deps.optionalText(body.summary, 500) || deps.excerpt(description);
      const tags = targetType === "skill" ? [] : deps.sanitizeTags(body.tags);
      const riskLevel = normalizeAssetRiskLevel(body.riskLevel);
      const visibility = normalizePublicationVisibility(body.visibility);
      const categoryId = await deps.ensureCategory(
        db,
        normalizeMarketCategoryName(body.category, targetType === "app" ? "workflow" : "research")
      );
      const teamId = await deps.currentUserTeamId(db, currentUser, context.env);
      const existing = await db
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
      const coverImageUrl = deps.normalizeAssetImageUrl(body.coverImageUrl === undefined
        ? existing?.coverImageUrl
        : restoreCatalogImageSource(targetType, targetId, body.coverImageUrl, existing?.coverImageUrl, context.request.url));
      const overviewMarkdown = deps.optionalText(body.overviewMarkdown, 200000) || deps.optionalText(body.descriptionMarkdown, 200000);
      const submittedBuilderSnapshot = appsSource
        ? {
            ...normalizeUnknownObject(body.builderSnapshot),
            appsVerified: appsSource.builderSnapshot
          }
        : normalizeUnknownObject(body.builderSnapshot);
      const builderSnapshot = targetType === "skill" ? omitSkillTagFields(submittedBuilderSnapshot) : submittedBuilderSnapshot;
      const versionId = appsSource?.versionId ?? readOptionalString(body.versionId);
      const submittedConfig = normalizeUnknownObject(body.config);
      const releaseReadyConfig = targetPlane === "apps" && targetType === "app"
        ? appsAppReleaseReadyConfig(submittedConfig, releaseReadiness)
        : submittedConfig;
      const config = {
        ...(targetType === "skill" ? omitSkillTagFields(releaseReadyConfig) : releaseReadyConfig),
        ...(overviewMarkdown ? { overviewMarkdown } : {}),
        source: "apps-worker",
        targetPlane,
        targetType,
        targetId,
        versionId,
        appsVerification: appsSource?.verification,
        builderSnapshot
      };
      const listingId = existing?.id ?? `listing-${targetType}-${deps.shortId()}-${deps.shortId()}`;
      const slug = existing?.slug ?? await deps.uniqueSlug(db, name);
      const version = await deps.uniquePublicationVersion(db, listingId, requestedVersion.slice(0, 80));
      const publicationVersionId = `market-version-${deps.shortId()}-${deps.shortId()}`;
      const artifactType = normalizePublicationArtifactType(body.artifactType, targetType);
      const artifactUrl = targetPlane === "apps" && targetType === "skill"
        ? `/api/listings/${encodeURIComponent(listingId)}/download`
        : (appsSource?.artifactUrl ?? readOptionalString(body.artifactUrl))?.slice(0, 1200) ?? null;
      const artifactBody = deps.optionalText(body.artifactBody, 200000);
      const changelog = deps.optionalText(body.changelog, 1200) || "Submitted from APPS Builder.";

      const statements: D1PreparedStatement[] = [];
      if (existing) {
        statements.push(
          db
            .prepare(
              `
              UPDATE publication_listings
              SET target_plane = ?,
                  review_version_id = ?,
                  name = ?,
                  summary = ?,
                  description = ?,
                  cover_image_url = ?,
                  category_id = ?,
                  tags_json = ?,
                  status = 'pending_review',
                  desired_status = 'pending_review',
                  visibility = ?,
                  risk_level = ?,
                  builder_snapshot_json = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
              `
            )
            .bind(targetPlane, versionId ?? version, name, summary, description, coverImageUrl, categoryId, JSON.stringify(tags), visibility, riskLevel, JSON.stringify(builderSnapshot), listingId)
        );
      } else {
        statements.push(
          db
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
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?)
              `
            )
            .bind(listingId, targetType, targetPlane, targetId, versionId ?? version, currentUser.id, name, slug, summary, description, coverImageUrl, categoryId, JSON.stringify(tags), visibility, riskLevel, JSON.stringify(builderSnapshot))
        );
      }

      statements.push(
        db
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
          .bind(publicationVersionId, listingId, version, artifactType, artifactUrl, artifactBody, JSON.stringify(config), changelog, currentUser.id),
        db
          .prepare(
            `
            INSERT INTO review_queue (id, item_type, title, owner_team_id, risk_level, status, submitted_at)
            VALUES (?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP)
            `
          )
          .bind(`review-${deps.shortId()}-${deps.shortId()}`, targetType, name, teamId, riskLevel)
      );

      await db.batch(statements);

      await deps.audit(db, "user", currentUser.id, "submitted publication listing", "publication_listing", listingId, {
        targetPlane,
        targetType,
        targetId,
        version,
        versionId,
        appsVerified: Boolean(appsSource),
        harnessReportUrl: releaseReadiness?.reportUrl,
        harnessSelfCheckConfirmed: releaseReadiness?.selfCheckConfirmed,
        riskLevel
      });

      return {
        listingId,
        publicationVersionId,
        targetId,
        targetPlane,
        targetType,
        version,
        status: "pending_review"
      };
    }
  };
}

function resolveAppsAppReleaseReadiness(
  body: PublicationSubmissionInput,
  appsSource: AppsPublicationSource | undefined,
  required: boolean,
  httpError: (status: number, message: string) => Error
) {
  const verifiedApp = normalizeUnknownObject(appsSource?.builderSnapshot.app);
  const productionUrl = readOptionalString(verifiedApp.productionUrl);
  const expectedReportUrl = workspaceHarnessReportUrl(productionUrl);
  const submittedReportUrl = readOptionalString(body.harnessReportUrl);

  if (!submittedReportUrl && !required) {
    return undefined;
  }
  if (!expectedReportUrl || !isWorkspaceHarnessReportUrl(submittedReportUrl, productionUrl)) {
    throw httpError(400, "invalid_harness_report_url");
  }
  if (required && body.harnessSelfCheckConfirmed !== true) {
    throw httpError(400, "harness_self_check_required");
  }

  return {
    reportName: WORKSPACE_RELEASE_READINESS_REPORT_NAME,
    reportUrl: expectedReportUrl,
    schemaVersion: WORKSPACE_RELEASE_READINESS_REPORT_SCHEMA,
    selfCheckConfirmed: body.harnessSelfCheckConfirmed === true
  };
}

function appsAppReleaseReadyConfig(
  submittedConfig: Record<string, unknown>,
  releaseReadiness: ReturnType<typeof resolveAppsAppReleaseReadiness>
) {
  const config = { ...submittedConfig };
  delete config.releaseReadiness;
  const reviewDraft = { ...normalizeUnknownObject(config.reviewDraft) };
  delete reviewDraft.harnessReportUrl;
  delete reviewDraft.harnessSelfCheckConfirmed;

  return {
    ...config,
    reviewDraft: releaseReadiness
      ? {
          ...reviewDraft,
          harnessReportUrl: releaseReadiness.reportUrl,
          harnessSelfCheckConfirmed: releaseReadiness.selfCheckConfirmed
        }
      : reviewDraft,
    ...(releaseReadiness ? { releaseReadiness } : {})
  };
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

function omitSkillTagFields(value: Record<string, unknown>) {
  const next = { ...value };
  delete next.tags;

  const reviewDraft = next.reviewDraft;
  if (reviewDraft && typeof reviewDraft === "object" && !Array.isArray(reviewDraft)) {
    next.reviewDraft = { ...(reviewDraft as Record<string, unknown>) };
    delete (next.reviewDraft as Record<string, unknown>).tags;
  }

  return next;
}
