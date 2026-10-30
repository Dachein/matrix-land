import {
  normalizeAppAccessMode,
  normalizeAppDataRegion,
  normalizeAppDeploymentMethod,
  normalizeAppDeploymentProvider,
  normalizeAppType,
  normalizeAssetRiskLevel,
  normalizeListingType,
  normalizePublicationStatus,
  normalizePublicationVisibility
} from "../publication/normalizers.ts";
import {
  assetUserProfileFromRow,
  readJsonArray,
  readJsonObject,
  readNumber,
  readOptionalString,
  readString,
  splitList
} from "./utils.ts";
import type { PublicationListing } from "../../../src/shared/types.ts";
import { cacheableCatalogImageUrl } from "./coverImage.ts";

export function publicationListingFromRow(row: Record<string, unknown>): PublicationListing {
  return {
    id: readString(row.id),
    type: normalizeListingType(row.type),
    targetPlane: readString(row.targetPlane) === "apps" ? "apps" : "portal",
    targetId: readString(row.targetId),
    listedVersionId: readOptionalString(row.listedVersionId),
    reviewVersionId: readOptionalString(row.reviewVersionId),
    name: readString(row.name),
    ownerAliasName: readOptionalString(row.ownerAliasName),
    submittedByProfile: assetUserProfileFromRow(row, "submittedBy", readString(row.submittedById)),
    status: normalizePublicationStatus(row.status),
    desiredStatus: normalizePublicationStatus(row.desiredStatus),
    effectiveStatus: normalizePublicationStatus(row.effectiveStatus),
    authPublicationStatus: normalizeAuthSyncStatus(row.authPublicationStatus),
    publicationErrorCode: readOptionalString(row.publicationErrorCode),
    visibility: normalizePublicationVisibility(row.visibility),
    homeDisplay: row.homeDisplay === "recommended" || row.homeDisplay === "normal" || row.homeDisplay === "hidden" ? row.homeDisplay : undefined,
    riskLevel: normalizeAssetRiskLevel(row.riskLevel),
    reviewNotes: readOptionalString(row.reviewNotes),
    artifactType: readOptionalString(row.artifactType),
    artifactUrl: readOptionalString(row.artifactUrl),
    config: readJsonObject(row.configJson),
    summary: readString(row.summary),
    description: readString(row.description),
    coverImageUrl: cacheableCatalogImageUrl(row.type, row.targetId, row.coverImageUrl),
    category: readString(row.category),
    tags: readJsonArray(row.tagsJson),
    installs: readNumber(row.installs),
    agentAddCount: readNumber(row.agentAddCount),
    downloadCount: readNumber(row.downloadCount),
    visitCount: readNumber(row.visitCount),
    comments: readNumber(row.comments),
    rating: readNumber(row.rating),
    likeCount: readNumber(row.likeCount),
    likedByCurrentUser: readNumber(row.likedByCurrentUser) > 0,
    updatedAt: readString(row.updatedAt)
  };
}

function normalizeAuthSyncStatus(value: unknown): PublicationListing["authPublicationStatus"] {
  return value === "failed" || value === "not_required" || value === "pending" || value === "synced"
    ? value
    : undefined;
}

export function skillFromRow(row: Record<string, unknown>) {
  const id = readString(row.id);
  return {
    ...row,
    id,
    coverImageUrl: cacheableCatalogImageUrl("skill", id, row.coverImageUrl),
    scopes: splitList(row.scopes),
    mcpTools: splitList(row.mcpTools),
    dependencies: splitList(row.dependencies)
  };
}

export function dataServiceFromRow(row: Record<string, unknown>) {
  return {
    ...row,
    scopes: splitList(row.scopes),
    tools: splitList(row.tools),
    boundSkills: splitList(row.boundSkills)
  };
}

export function appFromRow(row: Record<string, unknown>) {
  const id = readString(row.id);
  const screenshots = readJsonArray(row.screenshotsJson);
  return {
    ...row,
    id,
    coverImageUrl: cacheableCatalogImageUrl("app", id, row.coverImageUrl),
    appType: normalizeAppType(row.appType),
    publisherProfile: assetUserProfileFromRow(row, "publisher", readString(row.publisherId)),
    deploymentProvider: normalizeAppDeploymentProvider(row.deploymentProvider),
    deploymentMethod: normalizeAppDeploymentMethod(row.deploymentMethod),
    dataRegion: normalizeAppDataRegion(row.dataRegion),
    accessMode: normalizeAppAccessMode(row.accessMode),
    usesWorkspaceAuth: readNumber(row.usesWorkspaceAuth) === 1,
    tags: readJsonArray(row.tagsJson),
    screenshots: screenshots.map((imageUrl) => cacheableCatalogImageUrl("app", id, imageUrl) ?? imageUrl),
    dataTypes: readJsonArray(row.dataTypesJson),
    sensitiveDataTypes: readJsonArray(row.sensitiveDataJson),
    knowledgeSources: readJsonArray(row.knowledgeSourcesJson),
    accessTargets: readJsonArray(row.accessTargetsJson),
    viewCount: readNumber(row.viewCount),
    launchCount: readNumber(row.launchCount),
    scopes: splitList(row.scopes)
  };
}

export function mcpToolFromRow(row: Record<string, unknown>) {
  return {
    ...row,
    scopes: splitList(row.scopes)
  };
}
