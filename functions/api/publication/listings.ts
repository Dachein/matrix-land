import { isPublicHomeApp } from "../../../src/shared/homeApplications.ts";
import type { HomeAppDisplay, PortalCatalog } from "../../../src/shared/types.ts";
import { normalizeMarketCategoryName } from "../../../src/shared/marketCategories.ts";
import {
  schedulePortalLiveEvent,
  type PortalLiveDeferredContext,
  type PortalLivePublisherEnv
} from "../../../src/shared/portalLivePublisher.ts";
import type { CatalogCoverColumns, UserProfileColumns } from "../catalog/types.ts";
import { restoreCatalogImageSource } from "../catalog/coverImage.ts";
import { attachPublicationOwnerProfiles, readPublicationListings } from "../catalog/readModels.ts";
import {
  hasValidPublicationCoverImage,
  normalizeAssetRiskLevel,
  normalizeInstallType,
  normalizePublicationVisibility,
  normalizeReviewNote
} from "./normalizers.ts";
import {
  buildPublicationPublicationProjection,
  type PublicationAuthSyncResult,
  type PublicationPublicationProjection,
  type PublicationResourceSyncResult
} from "./authSync.ts";
import {
  publicationPublicationOutboxStatements,
  processPublicationPublicationJob,
  retryPublicationPublication,
  type PublicationPublicationProcessingResult
} from "./publicationOutbox.ts";
import type { AppsPublicationAuthors } from "./appsSource.ts";
import {
  PUBLICATION_EFFECTIVE_VERSION_PROJECTION_JOIN_SQL,
  PUBLICATION_LISTING_VERSION_PROJECTION_CTE_SQL,
  PUBLICATION_VERSION_PROJECTION_JOIN_SQL
} from "./versionProjection.ts";
import { notificationInsertStatement } from "../notifications/writes.ts";

type CurrentUser = PortalCatalog["currentUser"];
type PublicationBehaviorAction = "app.visit_url" | "skill.add_to_agent" | "skill.download_zip";

type PublicationListingsEnv = PortalLivePublisherEnv & {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  DB?: D1Database;
  DEFAULT_TEAM_ID?: string;
  APPS_JWT_SECRET?: string;
  APPS_ORG_ID?: string;
  APPS_ORG_SLUG?: string;
  APPS_WORKER_URL?: string;
  PORTAL_ISSUER?: string;
  TOKEN_TTL_SECONDS?: string;
};

type PublicationListingsContext<TEnv extends PublicationListingsEnv> = EventContext<TEnv, string, unknown>;

type PublicationListingsDeps<TEnv extends PublicationListingsEnv> = {
  audit(
    db: D1Database,
    actorType: string,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata?: Record<string, unknown>
  ): Promise<string>;
  currentUserTeamId(db: D1Database, currentUser: CurrentUser, env: TEnv): Promise<string>;
  ensureCategory(db: D1Database, value: string): Promise<string>;
  getTtlSeconds(env: TEnv): number;
  httpError(status: number, message: string): Error;
  appsOrgContext(env: TEnv, currentUser: CurrentUser): { orgId: string; orgSlug: string };
  appsWorkerBaseUrl(env: TEnv): string;
  normalizeAssetImageUrl(value: unknown): string;
  optionalText(value: unknown, maxLength: number): string;
  readBody<T>(request: Request): Promise<T>;
  readAppsPublicationAuthorIndex(
    context: PublicationListingsContext<TEnv>,
    currentUser: CurrentUser
  ): Promise<{ appIds: string[]; skillIds: string[] }>;
  readAppsPublicationAuthors(
    context: PublicationListingsContext<TEnv>,
    currentUser: CurrentUser,
    targetType: "app" | "skill",
    targetId: string
  ): Promise<AppsPublicationAuthors>;
  readAppsPublicationHubAccessIndex(
    context: PublicationListingsContext<TEnv>,
    currentUser: CurrentUser,
    targetIds?: string[],
    listingType?: "app" | "skill"
  ): Promise<{ appIds: string[]; publicAppIds?: string[]; skillIds: string[] }>;
  readAppsPublicationSource(
    context: PublicationListingsContext<TEnv>,
    currentUser: CurrentUser,
    targetType: "app" | "skill",
    targetId: string,
    requestedVersion?: string
  ): Promise<unknown>;
  syncAppsSkillVisibility?(
    context: PublicationListingsContext<TEnv>,
    currentUser: CurrentUser,
    skillId: string,
    visibility: "org" | "team" | "private"
  ): Promise<void>;
  requireAdminPortalUser(context: PublicationListingsContext<TEnv>): Promise<CurrentUser>;
  requireDb(db: D1Database | undefined): D1Database;
  requireText(value: unknown, errorCode: string, maxLength: number): string;
  resolveCurrentUser(context: PublicationListingsContext<TEnv>): Promise<CurrentUser>;
  refreshUserJourneyState?(
    db: D1Database,
    userId: string,
    publishContext?: PortalLiveDeferredContext<PortalLivePublisherEnv>
  ): Promise<unknown>;
  sanitizeTags(value: unknown): string[];
  signAppsToken(env: TEnv, payload: Record<string, unknown>): Promise<string>;
  catalogCoverColumns(db: D1Database): Promise<CatalogCoverColumns>;
  userProfileColumns(db: D1Database): Promise<UserProfileColumns>;
  fetch?: typeof fetch;
};

export function createPublicationListingsApi<TEnv extends PublicationListingsEnv>(deps: PublicationListingsDeps<TEnv>) {
  return {
    async listPublicationListings(context: PublicationListingsContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      const reviewView = new URL(context.request.url).searchParams.get("view") === "review";
      const currentUser = reviewView
        ? await deps.requireAdminPortalUser(context)
        : await deps.resolveCurrentUser(context);
      const [userColumns, coverColumns, additionalAuthorListingIds] = await Promise.all([
        deps.userProfileColumns(db),
        deps.catalogCoverColumns(db),
        currentUser.role === "admin"
          ? Promise.resolve([] as string[])
          : readAdditionalAuthorListingIds(db, context, currentUser, deps)
      ]);

      const publicationListings = await readPublicationListings(
        db,
        currentUser,
        userColumns,
        coverColumns,
        additionalAuthorListingIds,
        { attachOwnerProfiles: false }
      );

      const listingsWithOwners = await attachCurrentAppsOwnerProfiles(
        db,
        context,
        currentUser,
        publicationListings,
        userColumns,
        deps
      );
      return {
        // The review dialog needs the pinned review draft and resolved owners,
        // not full source snapshots, deployment history, or duplicated image bytes.
        publicationListings: reviewView
          ? listingsWithOwners.map((listing) => {
              const draft = listing.config?.reviewDraft;
              const reviewDraft = draft && typeof draft === "object" && !Array.isArray(draft)
                ? draft as Record<string, unknown>
                : {};
              return {
                ...listing,
                config: {
                  reviewDraft: {
                    ...reviewDraft,
                    ...(listing.coverImageUrl ? {
                      coverImageUrl: listing.coverImageUrl,
                      screenshots: [listing.coverImageUrl]
                    } : {})
                  }
                }
              };
            })
          : listingsWithOwners
      };
    },

    async listHubPublicationListings(context: PublicationListingsContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const url = new URL(context.request.url);
      const targetIds = readRequestedTargetIds(url);
      const listingType = url.searchParams.get("type") === "app"
        ? "app"
        : url.searchParams.get("type") === "skill"
          ? "skill"
          : undefined;
      const [userColumns, coverColumns] = await Promise.all([
        deps.userProfileColumns(db),
        deps.catalogCoverColumns(db)
      ]);
      const listed = (await readPublicationListings(
        db,
        currentUser,
        userColumns,
        coverColumns,
        [],
        {
          attachOwnerProfiles: false,
          includeAllListed: true,
          listingType,
          statusView: "effective",
          targetIds
        }
      )).filter((listing) => (
        listing.status === "listed"
        && listing.desiredStatus === "listed"
        && (targetIds.length === 0 || targetIds.includes(listing.targetId))
        && (!listingType || listing.type === listingType)
      ));
      const hasAppsTargets = listed.some((listing) => listing.targetPlane === "apps");
      const hasPortalTargets = listed.some((listing) => listing.targetPlane !== "apps");
      const [appsAccess, portalAccess] = await Promise.all([
        hasAppsTargets
          ? deps.readAppsPublicationHubAccessIndex(context, currentUser, targetIds, listingType)
          : Promise.resolve({ appIds: [] as string[], publicAppIds: undefined as string[] | undefined, skillIds: [] as string[] }),
        hasPortalTargets
          ? readPortalHubAccessIndex(
              db,
              currentUser,
              await deps.currentUserTeamId(db, currentUser, context.env),
              targetIds,
              listingType
            )
          : Promise.resolve({ appIds: [] as string[], publicAppIds: [] as string[], skillIds: [] as string[] })
      ]);
      const appsAppIds = new Set(appsAccess.appIds);
      const appsSkillIds = new Set(appsAccess.skillIds);
      const portalAppIds = new Set(portalAccess.appIds);
      const portalSkillIds = new Set(portalAccess.skillIds);

      const hubListings = listed.filter((listing) => {
        if (listing.targetPlane === "apps") {
          return listing.type === "app"
            ? appsAppIds.has(listing.targetId)
            : appsSkillIds.has(listing.targetId);
        }

        return listing.type === "app"
          ? portalAppIds.has(listing.targetId)
          : portalSkillIds.has(listing.targetId);
      });

      const projectedHubListings = await attachCurrentAppsOwnerProfiles(
        db,
        context,
        currentUser,
        hubListings,
        userColumns,
        deps
      );

      return {
        hubListings: projectedHubListings.map(({ submittedByProfile: _auditIdentity, ...listing }) => {
          if (listing.type !== "app") return listing;
          const publicAccess = listing.targetPlane === "apps"
            ? appsAccess.publicAppIds === undefined
              ? isPublicHomeApp(listing)
              : appsAccess.publicAppIds.includes(listing.targetId)
            : portalAccess.publicAppIds.includes(listing.targetId);
          return {
            ...listing,
            homeScope: listing.visibility === "org" && publicAccess ? "public" as const : "exclusive" as const
          };
        })
      };
    },

    async updateHomeApplicationDisplay(context: PublicationListingsContext<TEnv>, listingId: string) {
      const currentUser = await deps.requireAdminPortalUser(context);
      const db = deps.requireDb(context.env.DB);
      const body = await deps.readBody<{ display?: unknown }>(context.request);
      if (body.display !== "recommended" && body.display !== "normal" && body.display !== "hidden") {
        throw deps.httpError(400, "invalid_home_application_display");
      }
      const listing = await db.prepare(`SELECT id, listing_type AS type FROM publication_listings WHERE id = ? AND status != 'deleted'`)
        .bind(listingId).first<{ id: string; type: string }>();
      if (!listing || listing.type !== "app") throw deps.httpError(404, "home_application_not_found");
      const display = body.display as HomeAppDisplay;
      await db.prepare(`UPDATE publication_listings SET home_display = ? WHERE id = ?`)
        .bind(display, listingId).run();
      await deps.audit(db, "user", currentUser.id, "updated home application display", "publication_listing", listingId, { display });
      return { listingId, homeDisplay: display };
    },

    async deletePublicationListing(context: PublicationListingsContext<TEnv>, listingId: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const listing = await db
        .prepare(
          `
          SELECT
            id,
            listing_type AS listingType,
            target_plane AS targetPlane,
            target_id AS targetId,
            created_by_user_id AS createdByUserId,
            status,
            desired_status AS desiredStatus,
            effective_status AS effectiveStatus,
            listed_version_id AS listedVersionId,
            review_version_id AS reviewVersionId,
            builder_snapshot_json AS builderSnapshotJson,
            name,
            visibility
          FROM publication_listings
          WHERE id = ?
          LIMIT 1
          `
        )
        .bind(listingId)
        .first<{
          createdByUserId: string;
          builderSnapshotJson?: string;
          desiredStatus?: string;
          effectiveStatus?: string;
          id: string;
          listedVersionId?: string;
          listingType: string;
          name?: string;
          reviewVersionId?: string;
          status: string;
          targetId: string;
          targetPlane?: string;
          visibility?: string;
        }>();

      if (!listing) {
        throw deps.httpError(404, "listing_not_found");
      }

      if (currentUser.role !== "admin") {
        const isCollaborativeAppsListing = listing.targetPlane === "apps"
          && (listing.listingType === "app" || listing.listingType === "skill");
        if (!isCollaborativeAppsListing && listing.createdByUserId !== currentUser.id) {
          throw deps.httpError(403, "listing_delete_forbidden");
        }

        if (isCollaborativeAppsListing) {
          try {
            await deps.readAppsPublicationSource(
              context,
              currentUser,
              listing.listingType as "app" | "skill",
              listing.targetId
            );
          } catch (error) {
            if (isAuthorizationMiss(error)) {
              throw deps.httpError(403, "listing_delete_forbidden");
            }
            throw error;
          }
        }
      }

      const requestId = context.request.headers.get("x-request-id") ?? undefined;
      const projection = await buildPublicationPublicationProjection(db, {
        builderSnapshot: listing.builderSnapshotJson,
        createdByUserId: listing.createdByUserId,
        desiredStatus: "deleted",
        listedVersionId: listing.listedVersionId,
        listingId,
        listingName: listing.name,
        listingType: listing.listingType,
        reviewVersionId: listing.reviewVersionId,
        targetId: listing.targetId,
        targetPlane: listing.targetPlane,
        visibility: listing.visibility
      });
      const outbox = await publicationPublicationOutboxStatements(db, {
        desiredStatus: "deleted",
        listingId,
        projection,
        requestId
      });
      await db.batch([
        db
          .prepare(
            `
            UPDATE publication_listings
            SET status = 'deleted',
                desired_status = 'deleted',
                publication_status = 'pending',
                publication_error_code = '',
                publication_updated_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `
          )
          .bind(listingId),
        ...outbox.statements
      ]);
      const publication = await processPublicationPublicationJob(
        db,
        context.env,
        outbox.jobId,
        { fetch: deps.fetch }
      );
      const { authSync, resourceSync } = legacyPublicationSyncResults(
        projection,
        "deleted",
        publication
      );

      await deps.audit(db, "user", currentUser.id, "deleted publication listing", "publication_listing", listingId, {
        listingType: listing.listingType,
        targetId: listing.targetId,
        targetPlane: listing.targetPlane ?? "portal",
        desiredStatus: "deleted",
        previousEffectiveStatus: listing.effectiveStatus ?? listing.status,
        publicationJobId: outbox.jobId,
        authPublicationStatus: publication.publicationStatus,
        ...(authSync ? { authSync } : {}),
        ...(resourceSync ? { resourceSync } : {})
      });

      return {
        deleted: true,
        listingId,
        listingType: listing.listingType,
        targetId: listing.targetId
      };
    },

    async updatePublicationListingStatus(context: PublicationListingsContext<TEnv>, listingId: string) {
      const db = deps.requireDb(context.env.DB);
      const body = await deps.readBody<{
        category?: string;
        coverImageUrl?: string;
        description?: string;
        homeDisplay?: unknown;
        name?: string;
        ownerAliasName?: string;
        reviewNote?: string;
        riskLevel?: string;
        status?: string;
        summary?: string;
        tags?: unknown;
        visibility?: string;
      }>(context.request);
      const requestedStatus = readString(body.status).trim();
      if (requestedStatus === "deleted") {
        throw deps.httpError(400, "use_delete_listing_endpoint");
      }
      if (!isPublicationListingReviewStatus(requestedStatus)) {
        throw deps.httpError(400, "invalid_listing_status");
      }
      const status = requestedStatus;
      const currentUser = status === "delisted"
        ? await deps.resolveCurrentUser(context)
        : await deps.requireAdminPortalUser(context);
      const rawRiskLevel = readString(body.riskLevel);
      let riskLevel = normalizeAssetRiskLevel(body.riskLevel);
      const reviewNote = normalizeReviewNote(body.reviewNote);
      const category = readString(body.category) ? normalizeMarketCategoryName(body.category) : "";

      if (status === "listed" && !rawRiskLevel) {
        throw deps.httpError(400, "missing_review_risk_level");
      }

      const listing = await db
        .prepare(
          `
          SELECT
            id,
            listing_type AS listingType,
            target_plane AS targetPlane,
            target_id AS targetId,
            created_by_user_id AS createdByUserId,
            review_version_id AS reviewVersionId,
            listed_version_id AS listedVersionId,
            builder_snapshot_json AS builderSnapshotJson,
            status,
            desired_status AS desiredStatus,
            effective_status AS effectiveStatus,
            name,
            owner_alias_name AS ownerAliasName,
            summary,
            description,
            cover_image_url AS coverImageUrl,
            category_id AS categoryId,
            tags_json AS tagsJson,
            visibility,
            risk_level AS riskLevel,
            review_notes AS reviewNotes
          FROM publication_listings
          WHERE id = ?
          LIMIT 1
          `
        )
        .bind(listingId)
        .first<{
          categoryId?: string;
          coverImageUrl?: string;
          description?: string;
          desiredStatus?: string;
          effectiveStatus?: string;
          id: string;
          listedVersionId?: string;
          listingType: string;
          targetPlane?: string;
          name?: string;
          ownerAliasName?: string;
          reviewNotes?: string;
          riskLevel?: string;
          reviewVersionId?: string;
          createdByUserId?: string;
          builderSnapshotJson?: string;
          status: string;
          summary?: string;
          tagsJson?: string;
          targetId: string;
          visibility?: string;
        }>();

      if (!listing) {
        throw deps.httpError(404, "listing_not_found");
      }

      const currentDesiredStatus = readString(listing.desiredStatus) || listing.status;
      if (currentDesiredStatus === "deleted") {
        throw deps.httpError(409, "listing_deleted");
      }

      if (currentUser.role !== "admin") {
        if (status !== "delisted" || currentDesiredStatus !== "listed") {
          throw deps.httpError(403, "listing_status_update_forbidden");
        }

        const isCollaborativeAppsListing = listing.targetPlane === "apps"
          && (listing.listingType === "app" || listing.listingType === "skill");
        if (!isCollaborativeAppsListing && listing.createdByUserId !== currentUser.id) {
          throw deps.httpError(403, "listing_status_update_forbidden");
        }

        if (isCollaborativeAppsListing) {
          try {
            await deps.readAppsPublicationSource(
              context,
              currentUser,
              listing.listingType as "app" | "skill",
              listing.targetId
            );
          } catch (error) {
            if (isAuthorizationMiss(error)) {
              throw deps.httpError(403, "listing_status_update_forbidden");
            }
            throw error;
          }
        }
      }

      if (!isPublicationListingReviewStatus(currentDesiredStatus) || !isPublicationListingStatusTransitionAllowed(currentDesiredStatus, status)) {
        throw deps.httpError(409, "invalid_listing_status_transition");
      }

      if (!hasOwn(body, "riskLevel")) {
        riskLevel = normalizeAssetRiskLevel(listing.riskLevel);
      }

      const name = hasOwn(body, "name")
        ? deps.requireText(body.name, "missing_listing_name", 160)
        : readString(listing.name);
      const summary = hasOwn(body, "summary")
        ? deps.optionalText(body.summary, 500)
        : readString(listing.summary);
      const ownerAliasName = hasOwn(body, "ownerAliasName")
        ? deps.optionalText(body.ownerAliasName, 120)
        : readString(listing.ownerAliasName);
      const description = hasOwn(body, "description")
        ? deps.requireText(body.description, "missing_listing_description", 3000)
        : readString(listing.description);
      const coverImageUrl = hasOwn(body, "coverImageUrl")
        ? deps.normalizeAssetImageUrl(restoreCatalogImageSource(
            listing.listingType, listing.targetId, body.coverImageUrl, listing.coverImageUrl, context.request.url
          ))
        : readString(listing.coverImageUrl);
      const tags = hasOwn(body, "tags") ? deps.sanitizeTags(body.tags) : undefined;
      const tagsJson = tags ? JSON.stringify(tags) : readString(listing.tagsJson) || "[]";
      const visibility = hasOwn(body, "visibility")
        ? normalizePublicationVisibility(body.visibility)
        : normalizePublicationVisibility(listing.visibility);
      const resolvedReviewNote = hasOwn(body, "reviewNote") ? reviewNote : readString(listing.reviewNotes);
      const homeDisplay = body.homeDisplay;
      if (homeDisplay !== undefined) {
        if (listing.listingType !== "app" || typeof homeDisplay !== "string" || !["recommended", "normal", "hidden"].includes(homeDisplay)) {
          throw deps.httpError(400, "invalid_home_application_display");
        }
        if (homeDisplay === "recommended" && visibility !== "org") {
          throw deps.httpError(400, "home_recommendation_requires_public_app");
        }
        if (currentUser.role !== "admin") {
          throw deps.httpError(403, "admin_required");
        }
      }

      if (status === "listed" && !hasValidPublicationCoverImage(coverImageUrl)) {
        throw deps.httpError(400, "missing_valid_cover_image");
      }

      const categoryId = category ? await deps.ensureCategory(db, category) : "";
      const resolvedCategoryId = categoryId || readString(listing.categoryId);

      if (
        status === "listed"
        && listing.targetPlane === "apps"
        && listing.listingType === "skill"
        && deps.syncAppsSkillVisibility
      ) {
        await deps.syncAppsSkillVisibility(context, currentUser, listing.targetId, visibility);
      }

      const notificationStatements: D1PreparedStatement[] = [];
      const notificationIds: string[] = [];
      const isNewAppsApproval = listing.targetPlane === "apps"
        && currentDesiredStatus === "pending_review"
        && status === "listed";
      if (isNewAppsApproval) {
        const reviewVersionCreator = listing.reviewVersionId
          ? await db
            .prepare(
              `
              SELECT created_by_user_id AS createdByUserId
              FROM publication_versions
              WHERE listing_id = ?
                AND (
                  id = ?
                  OR version = ?
                  OR CASE WHEN json_valid(config_json) THEN json_extract(config_json, '$.versionId') ELSE NULL END = ?
                  OR CASE WHEN json_valid(config_json) THEN json_extract(config_json, '$.appsVerification.versionId') ELSE NULL END = ?
                )
              ORDER BY created_at DESC, id DESC
              LIMIT 1
              `
            )
            .bind(listingId, listing.reviewVersionId, listing.reviewVersionId, listing.reviewVersionId, listing.reviewVersionId)
            .first<{ createdByUserId?: string }>()
          : undefined;
        const builderSnapshot = readJsonObject(listing.builderSnapshotJson);
        const appsVerified = readJsonObject(builderSnapshot.appsVerified);
        const appsAsset = readJsonObject(appsVerified[listing.listingType] ?? appsVerified.app ?? appsVerified.skill);
        const snapshotOwnerUserId = readString(appsAsset.ownerUserId).trim();
        const snapshotOwner = snapshotOwnerUserId
          ? await db.prepare("SELECT id FROM users WHERE id = ? LIMIT 1").bind(snapshotOwnerUserId).first<{ id?: string }>()
          : undefined;
        const recipientUserIds = Array.from(new Set([
          readString(reviewVersionCreator?.createdByUserId).trim(),
          readString(listing.createdByUserId).trim(),
          readString(snapshotOwner?.id).trim()
        ].filter((id) => id && id !== currentUser.id)));
        recipientUserIds.forEach((recipientUserId) => {
          const notificationId = crypto.randomUUID();
          notificationIds.push(notificationId);
          notificationStatements.push(notificationInsertStatement(db, {
            actorUserId: currentUser.id,
            dedupeKey: `apps.review_approved:${listingId}:${listing.reviewVersionId || "current"}:${recipientUserId}`,
            entityId: listingId,
            entityType: "publication_listing",
            href: listing.listingType === "app"
              ? `#/apps/${encodeURIComponent(listing.targetId)}`
              : `#/skills/${encodeURIComponent(listing.targetId)}`,
            metadata: {
              listingId,
              listingName: name,
              listingType: listing.listingType,
              reviewNote: resolvedReviewNote,
              reviewVersionId: listing.reviewVersionId || undefined,
              targetId: listing.targetId
            },
            notificationType: "apps.review_approved",
            parentId: listingId,
            parentType: "publication_listing",
            recipientUserId,
            id: notificationId,
            summary: `APPS「${name}」审核已通过`
          }));
        });
      }

      const updateStatement = db
        .prepare(
            `
            UPDATE publication_listings
            SET status = ?,
                desired_status = ?,
                publication_status = 'pending',
                publication_error_code = '',
                publication_updated_at = CURRENT_TIMESTAMP,
                risk_level = ?,
                name = ?,
                owner_alias_name = ?,
                summary = ?,
                description = ?,
                cover_image_url = ?,
                category_id = NULLIF(?, ''),
                tags_json = ?,
                visibility = ?,
                review_notes = ?,
                listed_version_id = CASE
                  WHEN ? = 'listed' THEN COALESCE(NULLIF(review_version_id, ''), listed_version_id)
                  ELSE listed_version_id
                END,
                published_at = CASE WHEN ? = 'listed' THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE published_at END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `
        )
        .bind(
            status,
            status,
            riskLevel,
            name,
            ownerAliasName,
            summary,
            description,
            coverImageUrl,
            resolvedCategoryId,
            tagsJson,
            visibility,
            resolvedReviewNote,
            status,
            status,
            listingId
        );
      const requestId = context.request.headers.get("x-request-id") ?? undefined;
      const projection = await buildPublicationPublicationProjection(db, {
        builderSnapshot: listing.builderSnapshotJson,
        createdByUserId: listing.createdByUserId,
        desiredStatus: status,
        listedVersionId: status === "listed"
          ? readString(listing.reviewVersionId) || readString(listing.listedVersionId)
          : readString(listing.listedVersionId),
        listingId,
        listingName: name,
        listingType: listing.listingType,
        reviewVersionId: readString(listing.reviewVersionId),
        targetId: listing.targetId,
        targetPlane: listing.targetPlane,
        visibility
      });
      const outbox = await publicationPublicationOutboxStatements(db, {
        desiredStatus: status,
        listingId,
        projection,
        requestId
      });
      await db.batch([
        updateStatement,
        ...(homeDisplay === undefined ? [] : [db.prepare("UPDATE publication_listings SET home_display = ? WHERE id = ?").bind(homeDisplay, listingId)]),
        ...notificationStatements,
        ...outbox.statements
      ]);
      notificationIds.forEach((id) => {
        schedulePortalLiveEvent(context, { notificationId: id });
      });

      const publication = await processPublicationPublicationJob(
        db,
        context.env,
        outbox.jobId,
        { fetch: deps.fetch }
      );
      const authPublicationStatus = projection.kind === "none"
        && projection.payload.reason === "resource_not_required"
        ? undefined
        : publication.publicationStatus;
      const { authSync, resourceSync } = legacyPublicationSyncResults(
        projection,
        status,
        publication
      );

      await deps.audit(db, "user", currentUser.id, "set publication listing status", "publication_listing", listingId, {
        status,
        riskLevel,
        reviewNote: resolvedReviewNote,
        ...(category ? { category } : {}),
        editedFields: ["name", "ownerAliasName", "summary", "description", "coverImageUrl", "tags", "visibility", "homeDisplay"].filter((field) => hasOwn(body, field)),
        ...(homeDisplay === undefined ? {} : { homeDisplay }),
        coverChanged: hasOwn(body, "coverImageUrl") && coverImageUrl !== readString(listing.coverImageUrl),
        listingType: listing.listingType,
        targetId: listing.targetId,
        effectiveStatus: publication.state === "completed"
          ? status
          : readString(listing.effectiveStatus) || listing.status,
        publicationJobId: outbox.jobId,
        ...(authPublicationStatus ? { authPublicationStatus } : {}),
        ...(authSync ? { authSync } : {}),
        ...(resourceSync ? { resourceSync } : {})
      });

      const result: {
        authSync?: PublicationAuthSyncResult;
        authPublicationStatus?: AuthPublicationStatus;
        listingId: string;
        resourceSync?: PublicationResourceSyncResult;
        reviewNote: string;
        riskLevel: string;
        status: string;
        category?: string;
      } = {
        listingId,
        status,
        riskLevel,
        reviewNote: resolvedReviewNote
      };

      if (category) {
        result.category = category;
      }
      if (authSync) {
        result.authSync = authSync;
      }
      if (authPublicationStatus) {
        result.authPublicationStatus = authPublicationStatus;
      }
      if (resourceSync) {
        result.resourceSync = resourceSync;
      }

      return result;
    },

    async retryPublicationListingPublication(context: PublicationListingsContext<TEnv>, listingId: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.requireAdminPortalUser(context);
      const jobId = await retryPublicationPublication(db, listingId);
      if (!jobId) {
        throw deps.httpError(409, "publication_publication_not_retryable");
      }
      const publication = await processPublicationPublicationJob(
        db,
        context.env,
        jobId,
        { fetch: deps.fetch }
      );
      await deps.audit(db, "user", currentUser.id, "retried publication publication", "publication_listing", listingId, {
        publicationJobId: jobId,
        authPublicationStatus: publication.publicationStatus,
        state: publication.state
      });
      return {
        authPublicationStatus: publication.publicationStatus,
        listingId,
        publicationJobId: jobId,
        state: publication.state
      };
    },

    async recordPublicationInteraction(context: PublicationListingsContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<{
        action?: string;
        listingId?: string;
        source?: string;
        targetId?: string;
        version?: string;
      }>(context.request);
      const action = normalizePublicationBehaviorAction(body.action, deps.httpError);
      const listingId = readString(body.listingId).trim();
      const targetId = readString(body.targetId).trim();
      const source = readString(body.source).trim().slice(0, 80) || "portal";
      const expectedListingType = publicationBehaviorListingType(action);

      if (!listingId && !targetId) {
        throw deps.httpError(400, "missing_publication_interaction_target");
      }

      const listing = listingId
        ? await db
          .prepare(
            `
            SELECT
              id,
              listing_type AS listingType,
              target_plane AS targetPlane,
              target_id AS targetId,
              effective_status AS status
            FROM publication_listings
            WHERE id = ?
            LIMIT 1
            `
          )
          .bind(listingId)
          .first<{ id: string; listingType: string; status: string; targetId: string; targetPlane?: string }>()
        : await db
          .prepare(
            `
            SELECT
              id,
              listing_type AS listingType,
              target_plane AS targetPlane,
              target_id AS targetId,
              effective_status AS status
            FROM publication_listings
            WHERE listing_type = ? AND target_id = ?
            LIMIT 1
            `
          )
          .bind(expectedListingType, targetId)
          .first<{ id: string; listingType: string; status: string; targetId: string; targetPlane?: string }>();

      if (!listing) {
        throw deps.httpError(404, "listing_not_found");
      }
      if (listing.status !== "listed") {
        throw deps.httpError(409, "listing_not_listed");
      }
      if (listing.listingType !== expectedListingType) {
        throw deps.httpError(400, "publication_interaction_type_mismatch");
      }

      await assertHubListingAccessible(context, currentUser, listing);
      await recordPublicationBehavior(db, currentUser, listing, action, source);

      if (action === "skill.add_to_agent") {
        await recordPublicationInstallation(context, {
          currentUser,
          db,
          installType: "download",
          listingId: listing.id,
          listingType: listing.listingType,
          version: readString(body.version).trim() || undefined
        });
      } else {
        // App visits are Journey evidence; Skill install paths refresh inside
        // recordPublicationInstallation to avoid running the projection twice.
        await deps.refreshUserJourneyState?.(db, currentUser.id, context);
      }

      return {
        action,
        listingId: listing.id,
        recorded: true
      };
    },

    async downloadPublicationListing(context: PublicationListingsContext<TEnv>, listingId: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const statusColumn = currentUser.role === "admin"
        ? "publication_listings.desired_status"
        : "publication_listings.effective_status";
      const versionProjectionJoin = currentUser.role === "admin"
        ? PUBLICATION_VERSION_PROJECTION_JOIN_SQL
        : PUBLICATION_EFFECTIVE_VERSION_PROJECTION_JOIN_SQL;
      const listing = await db
        .prepare(
          `
          ${PUBLICATION_LISTING_VERSION_PROJECTION_CTE_SQL}
          SELECT
            publication_listings.id,
            publication_listings.name,
            publication_listings.listing_type AS listingType,
            publication_listings.target_plane AS targetPlane,
            publication_listings.target_id AS targetId,
            ${statusColumn} AS status,
            projected_publication_version.version AS version,
            projected_publication_version.artifact_url AS artifactUrl,
            projected_publication_version.artifact_body AS artifactBody,
            projected_publication_version.artifact_type AS artifactType,
            projected_publication_version.config_json AS versionConfigJson
          FROM publication_listing_projection AS publication_listings
          ${versionProjectionJoin}
          WHERE publication_listings.id = ?
          LIMIT 1
          `
        )
        .bind(listingId)
        .first<{
          artifactBody?: string;
          artifactType?: string;
          artifactUrl?: string;
          id: string;
          listingType: string;
          name: string;
          status: string;
          targetId: string;
          targetPlane?: string;
          version?: string;
          versionConfigJson?: string;
        }>();

      if (!listing) {
        throw deps.httpError(404, "listing_not_found");
      }

      const downloadSource = new URL(context.request.url).searchParams.get("source")?.trim().slice(0, 80)
        || "publication_detail";
      const isAdminReviewDownload = currentUser.role === "admin" && (
        listing.listingType === "app"
        || listing.status !== "listed"
        || downloadSource === "admin_review"
      );
      if (listing.status !== "listed" && !isAdminReviewDownload) {
        throw deps.httpError(409, "listing_not_listed");
      }

      if (!isAdminReviewDownload) {
        await assertHubListingAccessible(context, currentUser, listing);
        if (listing.listingType === "skill") {
          await recordPublicationBehavior(db, currentUser, listing, "skill.download_zip", downloadSource);
        }
        await recordPublicationInstallation(context, {
          currentUser,
          db,
          installType: "download",
          listingId,
          listingType: listing.listingType,
          version: readString(listing.version) || undefined
        });
      }

      if (listing.targetPlane === "apps" && listing.listingType === "skill") {
        const latestVersionId = latestAppsSkillVersionId(listing.versionConfigJson, listing.version);
        if (!latestVersionId) {
          throw deps.httpError(404, "listing_artifact_not_found");
        }
        return proxyAppsSkillArtifact(
          context,
          currentUser,
          listingId,
          listing.targetId,
          latestVersionId
        );
      }

      const appsArtifact = parseAppsSkillArtifactUrl(readString(listing.artifactUrl), context.request.url);
      if (appsArtifact) {
        return proxyAppsSkillArtifact(context, currentUser, listingId, appsArtifact.skillId, appsArtifact.version);
      }

      const artifactBody = readString(listing.artifactBody);
      if (artifactBody) {
        return new Response(artifactBody, {
          headers: {
            "content-disposition": `attachment; filename="${downloadFilename(listing.name, listing.artifactType)}"`,
            "content-type": contentTypeForArtifact(listing.artifactType)
          }
        });
      }

      const artifactUrl = readString(listing.artifactUrl);
      if (artifactUrl) {
        return Response.redirect(new URL(artifactUrl, context.request.url).toString(), 302);
      }

      throw deps.httpError(404, "listing_artifact_not_found");
    },

    async installPublicationListing(context: PublicationListingsContext<TEnv>, listingId: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<{ installType?: string; version?: string }>(context.request);
      const listing = await db
        .prepare(
          `
          SELECT
            id,
            name,
            listing_type AS listingType,
            target_plane AS targetPlane,
            target_id AS targetId,
            effective_status AS status
          FROM publication_listings
          WHERE id = ?
          LIMIT 1
          `
        )
        .bind(listingId)
        .first<{ id: string; name: string; listingType: string; status: string; targetId: string; targetPlane?: string }>();

      if (!listing) {
        throw deps.httpError(404, "listing_not_found");
      }

      if (listing.status !== "listed") {
        throw deps.httpError(409, "listing_not_listed");
      }

      await assertHubListingAccessible(context, currentUser, listing);
      const installType = normalizeInstallType(body.installType);
      return recordPublicationInstallation(context, {
        currentUser,
        db,
        installType,
        listingId,
        listingType: listing.listingType,
        version: body.version ?? undefined
      });
    }
  };

  async function recordPublicationBehavior(
    db: D1Database,
    currentUser: CurrentUser,
    listing: {
      id: string;
      listingType: string;
      targetId: string;
      targetPlane?: string;
    },
    action: PublicationBehaviorAction,
    source: string
  ) {
    const counterColumn = publicationBehaviorCounterColumn(action);
    await db
      .prepare(
        `
        UPDATE publication_listings
        SET ${counterColumn} = ${counterColumn} + 1
        WHERE id = ?
        `
      )
      .bind(listing.id)
      .run();

    await deps.audit(db, "user", currentUser.id, action, "publication_listing", listing.id, {
      actorEmail: currentUser.email,
      actorName: currentUser.name,
      actorTeam: currentUser.team,
      listingType: listing.listingType,
      source,
      targetId: listing.targetId,
      targetPlane: listing.targetPlane ?? "portal"
    });
  }

  async function recordPublicationInstallation(
    context: PublicationListingsContext<TEnv>,
    {
      currentUser,
      db,
      installType,
      listingId,
      listingType,
      version
    }: {
      currentUser: CurrentUser;
      db: D1Database;
      installType: "user" | "team" | "download" | "bookmark";
      listingId: string;
      listingType: string;
      version?: string;
    }
  ) {
    const teamId = await deps.currentUserTeamId(db, currentUser, context.env);
    const existing = await db
      .prepare(
        `
        SELECT id
        FROM publication_installations
        WHERE listing_id = ? AND user_id = ? AND install_type = ?
        LIMIT 1
        `
      )
      .bind(listingId, currentUser.id, installType)
      .first<{ id: string }>();

    if (existing) {
      await deps.refreshUserJourneyState?.(db, currentUser.id, context);
      return {
        id: existing.id,
        listingId,
        installed: false,
        message: "already_installed"
      };
    }

    const installId = crypto.randomUUID();
    const statements = [
      db
        .prepare(
          `
          INSERT INTO publication_installations (id, listing_id, user_id, team_id, version, install_type)
          VALUES (?, ?, ?, ?, ?, ?)
          `
        )
        .bind(installId, listingId, currentUser.id, teamId, version ?? null, installType)
    ];

    if (installType !== "bookmark") {
      statements.push(
        db
          .prepare(
            `
            UPDATE publication_listings
            SET install_count = install_count + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `
          )
          .bind(listingId)
      );
    }

    await db.batch(statements);

    await deps.audit(db, "user", currentUser.id, "installed publication listing", "publication_listing", listingId, {
      installId,
      installType,
      listingType
    });
    await deps.refreshUserJourneyState?.(db, currentUser.id, context);

    return {
      id: installId,
      listingId,
      installed: true
    };
  }

  async function assertHubListingAccessible(
    context: PublicationListingsContext<TEnv>,
    currentUser: CurrentUser,
    listing: { listingType: string; targetId: string; targetPlane?: string }
  ) {
    const targetType = listing.listingType === "app" ? "app" : "skill";
    let accessible = false;

    if (listing.targetPlane === "apps") {
      const index = await deps.readAppsPublicationHubAccessIndex(context, currentUser);
      accessible = targetType === "app"
        ? index.appIds.includes(listing.targetId)
        : index.skillIds.includes(listing.targetId);
    } else {
      const teamId = await deps.currentUserTeamId(deps.requireDb(context.env.DB), currentUser, context.env);
      const index = await readPortalHubAccessIndex(deps.requireDb(context.env.DB), currentUser, teamId);
      accessible = targetType === "app"
        ? index.appIds.includes(listing.targetId)
        : index.skillIds.includes(listing.targetId);
    }

    if (!accessible) {
      throw deps.httpError(404, "listing_not_found");
    }
  }

  async function proxyAppsSkillArtifact(context: PublicationListingsContext<TEnv>, currentUser: CurrentUser, listingId: string, skillId: string, version: string) {
    const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    const { orgId, orgSlug } = deps.appsOrgContext(context.env, currentUser);
    const token = await deps.signAppsToken(context.env, {
      typ: "publication_access",
      iss: context.env.PORTAL_ISSUER ?? "frontier-workspace",
      sub: currentUser.id,
      org_id: orgId,
      org_slug: orgSlug,
      provider: currentUser.identity.provider,
      oid: currentUser.identity.objectId,
      tid: currentUser.identity.tenantId,
      email: currentUser.email,
      listing_id: listingId,
      skill_id: skillId,
      scopes: ["apps:skills:read"],
      exp: Math.floor(Date.now() / 1000) + Math.min(deps.getTtlSeconds(context.env), 900)
    });
    const upstream = await fetchImpl(`${deps.appsWorkerBaseUrl(context.env)}/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}/download.zip`, {
      headers: {
        Accept: "application/zip",
        Authorization: `Bearer ${token}`
      }
    });

    if (!upstream.ok) {
      const responseText = await upstream.text();
      throw deps.httpError(upstream.status === 404 ? 404 : 502, `apps_skill_download_failed:${upstream.status}:${responseText.slice(0, 160)}`);
    }

    return new Response(upstream.body, {
      headers: {
        "content-disposition": upstream.headers.get("content-disposition") ?? `attachment; filename="${skillId}-${version}.zip"`,
        "content-type": upstream.headers.get("content-type") ?? "application/zip"
      }
    });
  }
}

function normalizePublicationBehaviorAction(
  value: unknown,
  httpError: (status: number, message: string) => Error
): PublicationBehaviorAction {
  if (value === "app.visit_url" || value === "skill.add_to_agent" || value === "skill.download_zip") {
    return value;
  }

  throw httpError(400, "invalid_publication_interaction_action");
}

function publicationBehaviorListingType(action: PublicationBehaviorAction): "app" | "skill" {
  return action === "app.visit_url" ? "app" : "skill";
}

function publicationBehaviorCounterColumn(action: PublicationBehaviorAction) {
  if (action === "app.visit_url") {
    return "visit_count";
  }

  return action === "skill.add_to_agent" ? "agent_add_count" : "zip_download_count";
}

async function readPortalHubAccessIndex(
  db: D1Database,
  currentUser: CurrentUser,
  currentTeamId: string,
  targetIds: string[] = [],
  listingType?: "app" | "skill"
) {
  const targetClause = targetIds.length > 0
    ? `AND id IN (${targetIds.map(() => "?").join(", ")})`
    : "";
  const appStatement = db.prepare(
    `
    SELECT
      id,
      access_mode AS accessMode,
      access_targets_json AS accessTargetsJson
    FROM apps
    WHERE status != 'deleted'
      ${targetClause}
    `
  );
  const skillStatement = db.prepare(
    `
    SELECT id, owner_team_id AS ownerTeamId, visibility
    FROM skills
    WHERE status != 'deleted'
      ${targetClause}
    `
  );
  const [appRows, skillRows] = await Promise.all([
    listingType === "skill"
      ? Promise.resolve({ results: [] as Array<{ accessMode: string; accessTargetsJson: string; id: string }> })
      : appStatement.bind(...targetIds).all<{ accessMode: string; accessTargetsJson: string; id: string }>(),
    listingType === "app"
      ? Promise.resolve({ results: [] as Array<{ id: string; ownerTeamId: string; visibility: string }> })
      : skillStatement.bind(...targetIds).all<{ id: string; ownerTeamId: string; visibility: string }>()
  ]);

  return {
    publicAppIds: (appRows.results ?? []).filter((app) => ["public", "request"].includes(app.accessMode)).map((app) => app.id),
    appIds: (appRows.results ?? [])
      .filter((app) => portalAppIsDiscoverable(app, currentUser))
      .map((app) => app.id),
    skillIds: (skillRows.results ?? [])
      .filter((skill) => portalSkillIsDiscoverable(skill, currentTeamId))
      .map((skill) => skill.id)
  };
}

function portalAppIsDiscoverable(
  app: { accessMode: string; accessTargetsJson: string },
  currentUser: CurrentUser
) {
  const accessMode = readString(app.accessMode).trim().toLowerCase();
  if (accessMode === "public" || accessMode === "request") {
    return true;
  }
  if (accessMode !== "targeted") {
    return false;
  }

  return readStringArray(app.accessTargetsJson).some((target) => accessTargetMatchesCurrentUser(target, currentUser));
}

function portalSkillIsDiscoverable(skill: { ownerTeamId: string; visibility: string }, currentTeamId: string) {
  const visibility = readString(skill.visibility).trim().toLowerCase();
  if (visibility === "internal" || visibility === "company" || visibility === "org" || visibility === "public") {
    return true;
  }
  return visibility === "team" && Boolean(currentTeamId) && skill.ownerTeamId === currentTeamId;
}

function accessTargetMatchesCurrentUser(target: string, currentUser: CurrentUser) {
  const normalized = target.trim().toLowerCase();
  if (normalized.startsWith("user:")) {
    const userId = normalizeAccessIdentity(normalized.slice("user:".length));
    return [currentUser.id, currentUser.email, currentUser.identity.objectId, currentUser.identity.principalName]
      .map(normalizeAccessIdentity)
      .filter(Boolean)
      .includes(userId);
  }
  if (!normalized.startsWith("department:")) {
    return false;
  }

  const departmentId = normalizeDepartmentPath(normalized.slice("department:".length));
  return [currentUser.departmentId, ...(currentUser.departmentPath ?? [])]
    .map(normalizeDepartmentPath)
    .filter(Boolean)
    .some((candidate) => candidate === departmentId || candidate.startsWith(`${departmentId}/`));
}

function readStringArray(value: unknown) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(readString(value));
    return Array.isArray(parsed) ? parsed.map(readString).map((item) => item.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function readRequestedTargetIds(url: URL) {
  return Array.from(new Set(url.searchParams.getAll("ids")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)))
    .slice(0, 24);
}

function normalizeAccessIdentity(value: unknown) {
  return readString(value).trim().toLowerCase();
}

function normalizeDepartmentPath(value: unknown) {
  return readString(value)
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join("/");
}

async function readAdditionalAuthorListingIds<TEnv extends PublicationListingsEnv>(
  db: D1Database,
  context: PublicationListingsContext<TEnv>,
  currentUser: CurrentUser,
  deps: PublicationListingsDeps<TEnv>
) {
  const [candidates, authorIndex] = await Promise.all([
    db
      .prepare(
        `
        SELECT id, listing_type AS listingType, target_id AS targetId
        FROM publication_listings
        WHERE status != 'deleted'
          AND target_plane = 'apps'
          AND listing_type IN ('app', 'skill')
        ORDER BY updated_at DESC
        `
      )
      .bind()
      .all<{ id: string; listingType: "app" | "skill"; targetId: string }>(),
    deps.readAppsPublicationAuthorIndex(context, currentUser)
  ]);
  const manageableAppIds = new Set(authorIndex.appIds);
  const manageableSkillIds = new Set(authorIndex.skillIds);

  return (candidates.results ?? [])
    .filter((candidate) => candidate.listingType === "app"
      ? manageableAppIds.has(candidate.targetId)
      : manageableSkillIds.has(candidate.targetId))
    .map((candidate) => candidate.id);
}

async function attachCurrentAppsOwnerProfiles<TEnv extends PublicationListingsEnv>(
  db: D1Database,
  context: PublicationListingsContext<TEnv>,
  currentUser: CurrentUser,
  listings: PortalCatalog["publicationListings"],
  userColumns: UserProfileColumns,
  deps: Pick<PublicationListingsDeps<TEnv>, "readAppsPublicationAuthors">
) {
  const liveAuthorReads = new Map<string, Promise<AppsPublicationAuthors>>();
  const authorEntries = await Promise.all(listings
    .filter((listing) => listing.status === "listed" && listing.targetPlane === "apps")
    .map(async (listing) => {
      const targetKey = `${listing.type}:${listing.targetId}`;
      let authorsPromise = liveAuthorReads.get(targetKey);
      if (!authorsPromise) {
        authorsPromise = deps.readAppsPublicationAuthors(
          context,
          currentUser,
          listing.type,
          listing.targetId
        );
        liveAuthorReads.set(targetKey, authorsPromise);
      }

      const authors = await authorsPromise;
      return [
        listing.id,
        [authors.ownerUserId, ...authors.collaboratorUserIds]
      ] as const;
    }));

  return attachPublicationOwnerProfiles(
    db,
    listings,
    userColumns,
    new Map<string, readonly string[]>(authorEntries)
  );
}

function isAuthorizationMiss(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const status = Number((error as { status?: unknown }).status);
  return status === 403 || status === 404;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

type PublicationListingReviewStatus = "pending_review" | "listed" | "delisted";
type AuthPublicationStatus = "synced" | "pending" | "failed" | "not_required";

const PUBLICATION_LISTING_STATUS_TRANSITIONS: Record<PublicationListingReviewStatus, readonly PublicationListingReviewStatus[]> = {
  pending_review: ["pending_review", "listed", "delisted"],
  // A new submission owns moving an already-reviewed Listing back into review.
  listed: ["listed", "delisted"],
  // A delisted Listing must be resubmitted and reviewed before it can be listed again.
  delisted: ["delisted"]
};

function isPublicationListingReviewStatus(value: string): value is PublicationListingReviewStatus {
  return value === "pending_review" || value === "listed" || value === "delisted";
}

function isPublicationListingStatusTransitionAllowed(from: PublicationListingReviewStatus, to: PublicationListingReviewStatus) {
  return PUBLICATION_LISTING_STATUS_TRANSITIONS[from].includes(to);
}

function legacyPublicationSyncResults(
  projection: PublicationPublicationProjection,
  desiredStatus: string,
  processing: PublicationPublicationProcessingResult
): {
  authSync?: PublicationAuthSyncResult;
  resourceSync?: PublicationResourceSyncResult;
} {
  const delivery = processing.delivery;
  if (!delivery) {
    return {};
  }

  if (projection.kind === "none") {
    if (projection.payload.reason === "workspace_auth_disabled") {
      return {
        authSync: {
          appId: projection.targetId,
          skipped: true,
          reason: "workspace_auth_disabled"
        }
      };
    }
    if (projection.payload.reason === "app_not_found") {
      return {
        authSync: {
          appId: projection.targetId,
          ...(!delivery.success ? { requestId: delivery.requestId } : {}),
          skipped: true,
          reason: "app_not_found"
        }
      };
    }
    return {};
  }

  if (delivery.success) {
    if (projection.kind === "app") {
      return {
        authSync: {
          appId: projection.targetId,
          status: desiredStatus,
          synced: true
        }
      };
    }
    return {
      resourceSync: {
        resourceId: projection.targetId,
        status: desiredStatus,
        synced: true
      }
    };
  }

  if (delivery.errorCode === "auth_worker_not_configured") {
    if (projection.kind === "app") {
      return {
        authSync: {
          appId: projection.targetId,
          skipped: true,
          reason: "auth_worker_not_configured"
        }
      };
    }
    return {
      resourceSync: {
        resourceId: projection.targetId,
        skipped: true,
        reason: "auth_worker_not_configured"
      }
    };
  }

  const errorCode = delivery.errorCode === "invalid_auth_worker_url"
    ? "invalid_auth_worker_url"
    : delivery.errorCode === "auth_worker_rejected_projection"
      ? "auth_worker_rejected_projection"
      : "auth_worker_request_failed";
  if (projection.kind === "app") {
    return {
      authSync: {
        appId: projection.targetId,
        errorCode,
        requestId: delivery.requestId,
        ...(delivery.httpStatus ? { status: delivery.httpStatus } : {}),
        synced: false
      }
    };
  }
  return {
    resourceSync: {
      errorCode,
      requestId: delivery.requestId,
      resourceId: projection.targetId,
      ...(delivery.httpStatus ? { status: delivery.httpStatus } : {}),
      synced: false
    }
  };
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function latestAppsSkillVersionId(configJson: unknown, fallbackVersion: unknown) {
  const config = readJsonObject(configJson);
  const verification = readJsonObject(config.appsVerification);
  const snapshotVersion = readJsonObject(readJsonObject(readJsonObject(config.builderSnapshot).appsVerified).version);
  return readString(config.versionId).trim()
    || readString(verification.versionId).trim()
    || readString(snapshotVersion.id).trim()
    || readString(fallbackVersion).trim()
    || undefined;
}

function readJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseAppsSkillArtifactUrl(value: string, baseUrl: string) {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value, baseUrl);
    const match = url.pathname.match(/^\/api\/apps\/skills\/([^/]+)\/versions\/([^/]+)\/download\.zip$/);
    if (!match?.[1] || !match[2]) {
      return undefined;
    }

    return {
      skillId: decodeURIComponent(match[1]),
      version: decodeURIComponent(match[2])
    };
  } catch {
    return undefined;
  }
}

function downloadFilename(name: string, artifactType: string | undefined) {
  const base = readString(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "publication-artifact";
  return `${base}.${artifactType === "skill_md" ? "md" : "txt"}`;
}

function contentTypeForArtifact(artifactType: string | undefined) {
  return artifactType === "skill_md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
}
