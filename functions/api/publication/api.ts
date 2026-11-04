import { platformBrandFromEnv } from "../../../src/shared/platformBrand.ts";
import type { Env } from "../env.ts";
import { audit } from "../audit.ts";
import { emitActivityEvent } from "../activity/service.ts";
import { catalogCoverColumns, userProfileColumns } from "../catalog/service.ts";
import { HttpError, parseJsonBody, readBody, requireDb } from "../http.ts";
import { appsOrgContext, appsWorkerBaseUrl } from "../appsProxy/context.ts";
import { APPS_READ_SCOPES } from "../appsProxy/scopes.ts";
import { signAppsToken } from "../appsProxy/tokenSigner.ts";
import {
  assertHttpUrl,
  ensureCategory,
  excerpt,
  normalizeAssetImageUrl,
  normalizeCoverImageUrl,
  sanitizeTags,
  shortId,
  uniquePublicationVersion,
  uniqueSlug
} from "../portalContent.ts";
import {
  currentUserTeamId,
  requireAdminPortalUser,
  resolveCurrentUser
} from "../identity/index.ts";
import { getTtlSeconds, optionalText, requireText } from "../values.ts";
import { recomputePortalUserJourney } from "../journey/service.ts";
import { createPublicationAssetsApi } from "./assets.ts";
import {
  createPublicationAppsAuthorIndexReader,
  createPublicationAppsHubAccessIndexReader,
  createPublicationAppsReviewAuthorReader,
  createPublicationAppsSkillVisibilitySync,
  createPublicationAppsSourceReader
} from "./appsSource.ts";
import { createPublicationListingsApi } from "./listings.ts";
import { createPublicationSubmissionsApi } from "./submissions.ts";

export function createPublicationServices() {
  const appsSourceDeps = {
    getTtlSeconds,
    httpError: (status: number, message: string) => new HttpError(status, message),
    appsOrgContext,
    appsReadScopes: APPS_READ_SCOPES,
    appsWorkerBaseUrl,
    parseJson: (value: string) => parseJsonBody(value) as Record<string, unknown>,
    signAppsToken
  };
  const readAppsPublicationSource = createPublicationAppsSourceReader<Env>(appsSourceDeps);
  const readAppsPublicationAuthorIndex = createPublicationAppsAuthorIndexReader<Env>(appsSourceDeps);
  const readAppsPublicationHubAccessIndex = createPublicationAppsHubAccessIndexReader<Env>(appsSourceDeps);
  const readAppsPublicationAuthors = createPublicationAppsReviewAuthorReader<Env>(appsSourceDeps);
  const syncAppsSkillVisibility = createPublicationAppsSkillVisibilitySync<Env>(appsSourceDeps);

  return {
    publicationAssetsApi: createPublicationAssetsApi<Env>({
      assertHttpUrl,
      audit,
      ensureCategory,
      httpError: (status, message) => new HttpError(status, message),
      normalizeAssetImageUrl,
      optionalText,
      readBody,
      requireAdminPortalUser,
      requireDb,
      requireText,
      sanitizeTags
    }),
    publicationListingsApi: createPublicationListingsApi<Env>({
      audit,
      currentUserTeamId,
      ensureCategory,
      getTtlSeconds,
      httpError: (status, message) => new HttpError(status, message),
      appsOrgContext,
      appsWorkerBaseUrl,
      normalizeAssetImageUrl,
      optionalText,
      readBody,
      readAppsPublicationAuthorIndex,
      readAppsPublicationAuthors,
      readAppsPublicationHubAccessIndex,
      readAppsPublicationSource,
      syncAppsSkillVisibility,
      requireAdminPortalUser,
      requireDb,
      requireText,
      refreshUserJourneyState: (db, userId, publishContext) => recomputePortalUserJourney(db, userId, {
        defaultLocale: platformBrandFromEnv(publishContext?.env ?? {}).defaultLocale,
        emitActivityEvent: (activityDb, input) => emitActivityEvent(activityDb, input, publishContext)
      }),
      resolveCurrentUser,
      sanitizeTags,
      signAppsToken,
      catalogCoverColumns,
      userProfileColumns
    }),
    publicationSubmissionsApi: createPublicationSubmissionsApi<Env>({
      audit,
      catalogCoverColumns,
      currentUserTeamId,
      ensureCategory,
      excerpt,
      httpError: (status, message) => new HttpError(status, message),
      normalizeAssetImageUrl,
      normalizeCoverImageUrl,
      optionalText,
      readBody,
      readAppsPublicationSource,
      requireDb,
      requireText,
      resolveCurrentUser,
      sanitizeTags,
      shortId,
      uniquePublicationVersion,
      uniqueSlug
    })
  };
}
