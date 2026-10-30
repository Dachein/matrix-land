import type { AppSensitiveDataType, AppsApp, AppsSkill, PublicationListing } from "../../shared/types";
import { normalizeMarketCategoryName } from "../../shared/marketCategories";
import { workspaceHarnessReportUrl } from "../../shared/harnessReport";
import { sensitiveDataOptions } from "./constants";
import type { AppsAppPublishDraft, AppsSkillPublishDraft } from "./types";
import { parseCommaList } from "./utils";

export function emptyAppPublishDraft(): AppsAppPublishDraft {
  return {
    accessMode: "public",
    accessTargets: "",
    category: "Workflow",
    changelog: "",
    coverImageUrl: "",
    dataRegion: "hong_kong",
    dataTypes: "",
    deploymentMethod: "serverless",
    deploymentProvider: "workspace_ai_cloud",
    descriptionEn: "",
    descriptionZh: "",
    harnessReportUrl: "",
    harnessSelfCheckConfirmed: false,
    knowledgeSources: "",
    modelProvider: "Manual / internal workflow",
    nameEn: "",
    nameZh: "",
    outputNotes: "",
    permissionNotes: "",
    riskLevel: "low",
    riskReason: "",
    sensitiveDataTypes: ["public_information"],
    subtitle: "",
    tags: "apps, app",
    usesWorkspaceAuth: true,
    version: "1.0.0"
  };
}

export function appPublishDraftFromProduct(app: AppsApp, listing?: PublicationListing): AppsAppPublishDraft {
  const draft = reviewDraftFromListing(listing);
  const defaults = emptyAppPublishDraft();
  const sensitiveDataTypes = readSensitiveDataTypes(draft, "sensitiveDataTypes", defaults.sensitiveDataTypes);
  const tags = listing?.tags?.length ? listing.tags.join(", ") : defaults.tags;

  return {
    ...defaults,
    accessMode: readAccessMode(draft, "accessMode", defaults.accessMode),
    accessTargets: readDraftStringList(draft, "accessTargets").join(", "),
    category: normalizeMarketCategoryName(listing?.category || readDraftString(draft, "category", defaults.category), "workflow"),
    changelog: readDraftString(draft, "changelog", defaults.changelog),
    coverImageUrl: listing?.coverImageUrl || readDraftString(draft, "coverImageUrl", defaults.coverImageUrl),
    dataRegion: readDataRegion(draft, "dataRegion", defaults.dataRegion),
    dataTypes: readDraftStringList(draft, "dataTypes").join(", "),
    deploymentMethod: readDeploymentMethod(draft, "deploymentMethod", defaults.deploymentMethod),
    deploymentProvider: "workspace_ai_cloud",
    descriptionEn: readDraftString(draft, "descriptionEn", defaults.descriptionEn),
    descriptionZh: readDraftString(draft, "descriptionZh", listing?.description || app.description),
    harnessReportUrl: workspaceHarnessReportUrl(app.productionUrl),
    harnessSelfCheckConfirmed: readDraftBoolean(draft, "harnessSelfCheckConfirmed", false),
    knowledgeSources: readDraftStringList(draft, "knowledgeSources").join(", "),
    modelProvider: readDraftString(draft, "modelProvider", defaults.modelProvider),
    nameEn: readDraftString(draft, "nameEn", app.name),
    nameZh: readDraftString(draft, "nameZh", app.name),
    outputNotes: readDraftString(draft, "outputNotes", defaults.outputNotes),
    permissionNotes: readDraftString(draft, "permissionNotes", defaults.permissionNotes),
    riskLevel: listing?.riskLevel ?? readRiskLevel(draft, "riskLevel", defaults.riskLevel),
    riskReason: readDraftString(draft, "riskReason", defaults.riskReason),
    sensitiveDataTypes,
    subtitle: readDraftString(draft, "subtitle", listing?.summary || app.description),
    tags,
    usesWorkspaceAuth: readDraftBoolean(draft, "usesWorkspaceAuth", defaults.usesWorkspaceAuth),
    version: readDraftString(draft, "version", defaults.version)
  };
}

export function emptySkillPublishDraft(): AppsSkillPublishDraft {
  return {
    category: "Research",
    coverImageUrl: "",
    description: "",
    installNotes: "",
    name: "",
    overviewMarkdown: "",
    riskLevel: "low",
    riskReason: "",
    version: "1.0.0"
  };
}

export function skillPublishDraftFromProduct(skill: AppsSkill, listing?: PublicationListing): AppsSkillPublishDraft {
  const draft = reviewDraftFromListing(listing);
  const version = skill.currentVersion ?? skill.versions[0]?.version ?? "1.0.0";
  const defaults = emptySkillPublishDraft();

  return {
    ...defaults,
    category: normalizeMarketCategoryName(listing?.category || readDraftString(draft, "category", defaults.category), "research"),
    coverImageUrl: listing?.coverImageUrl || readDraftString(draft, "coverImageUrl", defaults.coverImageUrl),
    description: readDraftString(draft, "description", listing?.description || skill.description),
    installNotes: readDraftString(draft, "installNotes", ""),
    name: readDraftString(draft, "name", listing?.name || skill.name),
    overviewMarkdown: readDraftString(draft, "overviewMarkdown", readListingConfigString(listing, "overviewMarkdown")),
    riskLevel: listing?.riskLevel ?? readRiskLevel(draft, "riskLevel", defaults.riskLevel),
    riskReason: readDraftString(draft, "riskReason", ""),
    version: readDraftString(draft, "version", version)
  };
}

export function reviewDraftFromListing(listing?: PublicationListing) {
  const draft = listing?.config?.reviewDraft;
  return isPlainRecord(draft) ? draft : {};
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readDraftString(source: Record<string, unknown>, key: string, fallback = "") {
  const value = source[key];
  return typeof value === "string" ? value : fallback;
}

function readListingConfigString(listing: PublicationListing | undefined, key: string) {
  const value = listing?.config?.[key];
  return typeof value === "string" ? value : "";
}

function readDraftBoolean(source: Record<string, unknown>, key: string, fallback: boolean) {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

function readDraftStringList(source: Record<string, unknown>, key: string) {
  const value = source[key];

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  return typeof value === "string" ? parseCommaList(value) : [];
}

function readRiskLevel(source: Record<string, unknown>, key: string, fallback: AppsAppPublishDraft["riskLevel"]) {
  const value = source[key];
  return value === "low" || value === "medium" || value === "high" ? value : fallback;
}

function readAccessMode(source: Record<string, unknown>, key: string, fallback: AppsAppPublishDraft["accessMode"]) {
  const value = source[key];
  return value === "public" || value === "request" || value === "targeted" ? value : fallback;
}

function readDeploymentMethod(source: Record<string, unknown>, key: string, fallback: AppsAppPublishDraft["deploymentMethod"]) {
  const value = source[key];
  return value === "docker" || value === "serverless" || value === "vps" ? value : fallback;
}

function readDataRegion(source: Record<string, unknown>, key: string, fallback: AppsAppPublishDraft["dataRegion"]) {
  const value = source[key];
  return value === "hong_kong" || value === "mainland_china" || value === "singapore" || value === "north_america" || value === "other" ? value : fallback;
}

function readSensitiveDataTypes(source: Record<string, unknown>, key: string, fallback: AppSensitiveDataType[]) {
  const allowed = new Set(sensitiveDataOptions.map((option) => option.value));
  const values = readDraftStringList(source, key).filter((value): value is AppSensitiveDataType => allowed.has(value as AppSensitiveDataType));
  return values.length > 0 ? values : fallback;
}
