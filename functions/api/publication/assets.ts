import type { PortalCatalog } from "../../../src/shared/types.ts";
import { restoreCatalogImageSource } from "../catalog/coverImage.ts";
import { normalizeMarketCategoryName } from "../../../src/shared/marketCategories.ts";
import type { AppReviewMetadataInput, AssetManageType } from "./normalizers.ts";
import {
  hasValidPublicationCoverImage,
  normalizeAppReviewMetadata,
  normalizeAssetLifecycleStatus,
  normalizeAssetRiskLevel,
  normalizePublicationVisibility,
  normalizeReviewNote
} from "./normalizers.ts";
import {
  syncPublicationAppAuth,
  syncPublicationResourceAuthForTarget,
  type PublicationAuthSyncResult,
  type PublicationResourceSyncResult
} from "./authSync.ts";

type CurrentUser = PortalCatalog["currentUser"];

type PublicationAssetsEnv = {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  DB?: D1Database;
};

type PublicationAssetsContext<TEnv extends PublicationAssetsEnv> = EventContext<TEnv, string, unknown>;

type PublicationAssetsDeps<TEnv extends PublicationAssetsEnv> = {
  assertHttpUrl(value: string, errorCode: string): URL;
  audit(
    db: D1Database,
    actorType: string,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata?: Record<string, unknown>
  ): Promise<string>;
  httpError(status: number, message: string): Error;
  fetch?: typeof fetch;
  ensureCategory(db: D1Database, value: string): Promise<string>;
  normalizeAssetImageUrl(value: unknown): string;
  optionalText(value: unknown, maxLength: number): string;
  readBody<T>(request: Request): Promise<T>;
  requireAdminPortalUser(context: PublicationAssetsContext<TEnv>): Promise<CurrentUser>;
  requireDb(db: D1Database | undefined): D1Database;
  requireText(value: unknown, errorCode: string, maxLength: number): string;
  sanitizeTags(value: unknown): string[];
};

export function createPublicationAssetsApi<TEnv extends PublicationAssetsEnv>(deps: PublicationAssetsDeps<TEnv>) {
  return {
    async updateAssetLifecycleStatus(context: PublicationAssetsContext<TEnv>, assetType: AssetManageType, assetId: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.requireAdminPortalUser(context);
      const body = await deps.readBody<{
        app?: AppReviewMetadataInput;
        category?: string;
        coverImageUrl?: string;
        description?: string;
        name?: string;
        reviewNote?: string;
        riskLevel?: string;
        status?: string;
        summary?: string;
        tags?: unknown;
        visibility?: string;
      }>(context.request);
      const status = normalizeAssetLifecycleStatus(body.status);
      const rawRiskLevel = readString(body.riskLevel);
      const riskLevel = normalizeAssetRiskLevel(body.riskLevel);
      const reviewNote = normalizeReviewNote(body.reviewNote);
      const categoryInput = readString(body.category) || readString(body.app?.category);
      const category = categoryInput && assetType !== "mcp" ? normalizeMarketCategoryName(categoryInput) : "";
      if (status === "deleted") {
        throw deps.httpError(400, "use_delete_asset_endpoint");
      }
      if (status === "listed" && !rawRiskLevel) {
        throw deps.httpError(400, "missing_review_risk_level");
      }
      const asset = await assertAssetExists(db, assetType, assetId, deps);
      const normalizeReviewImageUrl = (value: unknown) => deps.normalizeAssetImageUrl(
        restoreCatalogImageSource(assetType, assetId, value, asset.coverImageUrl, context.request.url)
      );
      const appReview = assetType === "app" && body.app
        ? normalizeAppReviewMetadata(body.app, {
          assertHttpUrl: deps.assertHttpUrl,
          normalizeAssetImageUrl: normalizeReviewImageUrl,
          optionalText: deps.optionalText,
          requireText: deps.requireText
        })
        : undefined;
      const listingEdit = assetType !== "mcp" && hasOwn(body, "name")
        ? {
            coverImageUrl: normalizeReviewImageUrl(body.coverImageUrl),
            description: deps.requireText(body.description, "missing_listing_description", 3000),
            name: deps.requireText(body.name, "missing_listing_name", 160),
            summary: deps.optionalText(body.summary, 500),
            tags: deps.sanitizeTags(body.tags),
            visibility: normalizePublicationVisibility(body.visibility)
          }
        : undefined;

      if (asset.status === "deleted") {
        throw deps.httpError(409, "asset_deleted");
      }

      if (
        status === "listed"
        && assetType !== "mcp"
        && !hasValidPublicationCoverImage(appReview?.coverImageUrl || listingEdit?.coverImageUrl || asset.coverImageUrl)
      ) {
        throw deps.httpError(400, "missing_valid_cover_image");
      }

      const categoryId = category ? await deps.ensureCategory(db, category) : "";

      if (assetType === "app") {
        const appStatements = appReview
          ? [
            db
              .prepare(
                `
                UPDATE apps
                SET status = ?,
                    risk_level = ?,
                    review_notes = CASE WHEN ? != '' THEN ? ELSE review_notes END,
                    name = ?,
                    name_zh = ?,
                    name_en = ?,
                    subtitle = ?,
                    app_type = ?,
                    description = ?,
                    description_zh = ?,
                    description_en = ?,
                    launch_url = ?,
                    callback_url = ?,
                    model = ?,
                    model_provider = ?,
                    deployment_type = ?,
                    deployment_provider = ?,
                    deployment_method = ?,
                    data_region = ?,
                    data_types_json = ?,
                    sensitive_data_json = ?,
                    knowledge_sources_json = ?,
                    user_scope = ?,
                    access_mode = ?,
                    access_targets_json = ?,
                    uses_workspace_auth = ?,
                    risk_reason = ?,
                    permission_notes = ?,
                    output_notes = ?,
                    current_version = ?,
                    changelog = ?,
                    listed_at = CASE WHEN ? = 'listed' THEN COALESCE(listed_at, CURRENT_TIMESTAMP) ELSE listed_at END,
                    delisted_at = CASE WHEN ? = 'delisted' THEN CURRENT_TIMESTAMP WHEN ? = 'listed' THEN NULL ELSE delisted_at END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                `
              )
              .bind(
                status,
                riskLevel,
                reviewNote,
                reviewNote,
                appReview.name,
                appReview.nameZh,
                appReview.nameEn,
                appReview.subtitle,
                appReview.appType,
                appReview.description,
                appReview.descriptionZh,
                appReview.descriptionEn,
                appReview.launchUrl,
                appReview.callbackUrl,
                appReview.model,
                appReview.modelProvider,
                appReview.deploymentType,
                appReview.deploymentProvider,
                appReview.deploymentMethod,
                appReview.dataRegion,
                JSON.stringify(appReview.dataTypes),
                JSON.stringify(appReview.sensitiveDataTypes),
                JSON.stringify(appReview.knowledgeSources),
                appReview.userScope,
                appReview.accessMode,
                JSON.stringify(appReview.accessTargets),
                appReview.usesWorkspaceAuth ? 1 : 0,
                appReview.riskReason,
                appReview.permissionNotes,
                appReview.outputNotes,
                appReview.version,
                appReview.changelog,
                status,
                status,
                status,
                assetId
              ),
            db
              .prepare(
                `
                UPDATE app_catalog_metadata
                SET cover_image_url = ?,
                    screenshots_json = ?,
                    tags_json = CASE WHEN ? = 1 THEN ? ELSE tags_json END,
                    category_id = CASE WHEN ? != '' THEN ? ELSE category_id END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE app_id = ?
                `
              )
              .bind(appReview.coverImageUrl, JSON.stringify(appReview.screenshots), listingEdit ? 1 : 0, JSON.stringify(listingEdit?.tags ?? []), categoryId, categoryId, assetId),
            db
              .prepare(
                `
                UPDATE publication_listings
                SET status = ?,
                    name = ?,
                    summary = ?,
                    description = ?,
                    cover_image_url = ?,
                    tags_json = CASE WHEN ? = 1 THEN ? ELSE tags_json END,
                    visibility = CASE WHEN ? = 1 THEN ? ELSE visibility END,
                    category_id = CASE WHEN ? != '' THEN ? ELSE category_id END,
                    published_at = CASE WHEN ? = 'listed' THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE published_at END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE listing_type = 'app' AND target_id = ?
                `
              )
              .bind(status, appReview.name, appReview.subtitle, appReview.description, appReview.coverImageUrl, listingEdit ? 1 : 0, JSON.stringify(listingEdit?.tags ?? []), listingEdit ? 1 : 0, listingEdit?.visibility ?? "org", categoryId, categoryId, status, assetId)
          ]
          : [
            db
              .prepare(
                `
                UPDATE apps
                SET status = ?,
                    risk_level = ?,
                    review_notes = CASE WHEN ? != '' THEN ? ELSE review_notes END,
                    listed_at = CASE WHEN ? = 'listed' THEN COALESCE(listed_at, CURRENT_TIMESTAMP) ELSE listed_at END,
                    delisted_at = CASE WHEN ? = 'delisted' THEN CURRENT_TIMESTAMP WHEN ? = 'listed' THEN NULL ELSE delisted_at END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                `
              )
              .bind(status, riskLevel, reviewNote, reviewNote, status, status, status, assetId),
            db
              .prepare(
                `
                UPDATE publication_listings
                SET status = ?,
                    category_id = CASE WHEN ? != '' THEN ? ELSE category_id END,
                    published_at = CASE WHEN ? = 'listed' THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE published_at END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE listing_type = 'app' AND target_id = ?
                `
              )
              .bind(status, categoryId, categoryId, status, assetId)
          ];

        await db.batch(appStatements);
      } else if (assetType === "skill") {
        await db.batch([
          db
            .prepare(
              `
              UPDATE skills
              SET status = ?,
                  risk_level = ?,
                  review_notes = CASE WHEN ? != '' THEN ? ELSE review_notes END,
                  name = CASE WHEN ? != '' THEN ? ELSE name END,
                  description = CASE WHEN ? != '' THEN ? ELSE description END,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
              `
            )
            .bind(status, riskLevel, reviewNote, reviewNote, listingEdit?.name ?? "", listingEdit?.name ?? "", listingEdit?.description ?? "", listingEdit?.description ?? "", assetId),
          db
            .prepare(
              `
              UPDATE skill_catalog_metadata
              SET category_id = CASE WHEN ? != '' THEN ? ELSE category_id END,
                  cover_image_url = CASE WHEN ? = 1 THEN ? ELSE cover_image_url END,
                  updated_at = CURRENT_TIMESTAMP
              WHERE skill_id = ?
              `
            )
            .bind(categoryId, categoryId, listingEdit ? 1 : 0, listingEdit?.coverImageUrl ?? "", assetId),
          db
            .prepare(
              `
              UPDATE publication_listings
              SET status = ?,
                  name = CASE WHEN ? != '' THEN ? ELSE name END,
                  summary = CASE WHEN ? != '' THEN ? ELSE summary END,
                  description = CASE WHEN ? != '' THEN ? ELSE description END,
                  cover_image_url = CASE WHEN ? = 1 THEN ? ELSE cover_image_url END,
                  tags_json = CASE WHEN ? = 1 THEN ? ELSE tags_json END,
                  visibility = CASE WHEN ? = 1 THEN ? ELSE visibility END,
                  category_id = CASE WHEN ? != '' THEN ? ELSE category_id END,
                  published_at = CASE WHEN ? = 'listed' THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE published_at END,
                  updated_at = CURRENT_TIMESTAMP
              WHERE listing_type = 'skill' AND target_id = ?
              `
            )
            .bind(
              status,
              listingEdit?.name ?? "",
              listingEdit?.name ?? "",
              listingEdit?.summary ?? "",
              listingEdit?.summary ?? "",
              listingEdit?.description ?? "",
              listingEdit?.description ?? "",
              listingEdit ? 1 : 0,
              listingEdit?.coverImageUrl ?? "",
              listingEdit ? 1 : 0,
              JSON.stringify(listingEdit?.tags ?? []),
              listingEdit ? 1 : 0,
              listingEdit?.visibility ?? "org",
              categoryId,
              categoryId,
              status,
              assetId
            )
        ]);
      } else {
        await db.batch([
          db
            .prepare(
              `
              UPDATE mcp_servers
              SET status = ?,
                  risk_level = ?,
                  review_notes = CASE WHEN ? != '' THEN ? ELSE review_notes END
              WHERE id = ?
              `
            )
            .bind(status, riskLevel, reviewNote, reviewNote, assetId),
          db
            .prepare(
              `
              UPDATE mcp_tools
              SET status = ?
              WHERE server_id = ?
              `
            )
            .bind(status, assetId)
        ]);
      }

      const authSync = assetType === "app"
        ? await syncPublicationAppAuth(db, context.env, assetId, { fetch: deps.fetch }, {
          requestId: context.request.headers.get("x-request-id") ?? undefined,
          status
        })
        : undefined;
      const resourceSync = assetType === "skill"
        ? await syncPublicationResourceAuthForTarget(db, context.env, "skill", assetId, { fetch: deps.fetch }, {
          requestId: context.request.headers.get("x-request-id") ?? undefined,
          status
        })
        : undefined;

      await deps.audit(db, "user", currentUser.id, `set ${assetType} status`, assetType, assetId, {
        status,
        riskLevel,
        reviewNote,
        ...(category ? { category } : {}),
        ...(authSync ? { authSync } : {}),
        ...(resourceSync ? { resourceSync } : {})
      });

      const result: {
        authSync?: PublicationAuthSyncResult;
        resourceSync?: PublicationResourceSyncResult;
        reviewNote: string;
        riskLevel: string;
        status: string;
        category?: string;
        targetId: string;
        targetType: AssetManageType;
      } = {
        targetType: assetType,
        targetId: assetId,
        status,
        riskLevel,
        reviewNote
      };

      if (authSync) {
        result.authSync = authSync;
      }
      if (resourceSync) {
        result.resourceSync = resourceSync;
      }
      if (category) {
        result.category = category;
      }

      return result;
    },

    async deleteAsset(context: PublicationAssetsContext<TEnv>, assetType: AssetManageType, assetId: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.requireAdminPortalUser(context);
      const body = await deps.readBody<{ reviewNote?: string }>(context.request);
      const reviewNote = normalizeReviewNote(body.reviewNote);

      await assertAssetExists(db, assetType, assetId, deps);

      if (assetType === "app") {
        await db.batch([
          db
            .prepare(
              `
              UPDATE apps
              SET status = 'deleted',
                  deleted_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
              `
            )
            .bind(assetId),
          db
            .prepare(
              `
              UPDATE publication_listings
              SET status = 'deleted',
                  updated_at = CURRENT_TIMESTAMP
              WHERE listing_type = 'app' AND target_id = ?
              `
            )
            .bind(assetId)
        ]);
      } else if (assetType === "skill") {
        await db.batch([
          db
            .prepare(
              `
              UPDATE skills
              SET status = 'deleted',
                  deleted_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
              `
            )
            .bind(assetId),
          db
            .prepare(
              `
              UPDATE publication_listings
              SET status = 'deleted',
                  updated_at = CURRENT_TIMESTAMP
              WHERE listing_type = 'skill' AND target_id = ?
              `
            )
            .bind(assetId)
        ]);
      } else {
        await db.batch([
          db
            .prepare(
              `
              UPDATE mcp_servers
              SET status = 'deleted'
              WHERE id = ?
              `
            )
            .bind(assetId),
          db
            .prepare(
              `
              UPDATE mcp_tools
              SET status = 'deleted'
              WHERE server_id = ?
              `
            )
            .bind(assetId)
        ]);
      }

      await deps.audit(db, "user", currentUser.id, `deleted ${assetType}`, assetType, assetId, { reviewNote });

      return {
        targetType: assetType,
        targetId: assetId,
        status: "deleted"
      };
    }
  };
}

async function assertAssetExists<TEnv extends PublicationAssetsEnv>(
  db: D1Database,
  assetType: AssetManageType,
  assetId: string,
  deps: Pick<PublicationAssetsDeps<TEnv>, "httpError">
): Promise<{ coverImageUrl?: string; id: string; status: string }> {
  const row = assetType === "app"
    ? await db.prepare(`
        SELECT
          apps.id,
          apps.status,
          COALESCE(
            (SELECT NULLIF(cover_image_url, '') FROM publication_listings WHERE listing_type = 'app' AND target_id = apps.id LIMIT 1),
            (SELECT NULLIF(cover_image_url, '') FROM app_catalog_metadata WHERE app_id = apps.id LIMIT 1),
            ''
          ) AS coverImageUrl
        FROM apps
        WHERE apps.id = ?
        LIMIT 1
      `).bind(assetId).first<{ coverImageUrl?: string; id: string; status: string }>()
    : assetType === "skill"
      ? await db.prepare(`
          SELECT
            skills.id,
            skills.status,
            COALESCE(
              (SELECT NULLIF(cover_image_url, '') FROM publication_listings WHERE listing_type = 'skill' AND target_id = skills.id LIMIT 1),
              (SELECT NULLIF(cover_image_url, '') FROM skill_catalog_metadata WHERE skill_id = skills.id LIMIT 1),
              ''
            ) AS coverImageUrl
          FROM skills
          WHERE skills.id = ?
          LIMIT 1
        `).bind(assetId).first<{ coverImageUrl?: string; id: string; status: string }>()
      : await db.prepare("SELECT id, status FROM mcp_servers WHERE id = ? LIMIT 1").bind(assetId).first<{ id: string; status: string }>();

  if (!row) {
    throw deps.httpError(404, `${assetType}_not_found`);
  }

  return row;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
