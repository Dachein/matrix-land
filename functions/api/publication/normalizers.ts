export type AssetManageType = "app" | "skill" | "mcp";
export type PublicationSubmissionTargetType = "app" | "skill";

export type AppReviewMetadataInput = {
  appType?: string;
  category?: string;
  nameZh?: string;
  nameEn?: string;
  subtitle?: string;
  descriptionZh?: string;
  descriptionEn?: string;
  description?: string;
  launchUrl?: string;
  callbackUrl?: string;
  coverImageUrl?: string;
  screenshots?: unknown;
  version?: string;
  changelog?: string;
  accessMode?: string;
  accessTargets?: unknown;
  usesWorkspaceAuth?: boolean;
  deploymentType?: string;
  deploymentProvider?: string;
  deploymentMethod?: string;
  dataRegion?: string;
  model?: string;
  modelProvider?: string;
  dataTypes?: unknown;
  sensitiveDataTypes?: unknown;
  knowledgeSources?: unknown;
  riskReason?: string;
  permissionNotes?: string;
  outputNotes?: string;
};

type AppReviewMetadataDeps = {
  assertHttpUrl(value: string, errorCode: string): URL;
  normalizeAssetImageUrl(value: unknown): string;
  optionalText(value: unknown, maxLength: number): string;
  requireText(value: unknown, errorCode: string, maxLength: number): string;
};

export function normalizeAppType(value: unknown): "web" | "agent_chat" {
  return readString(value) === "agent_chat" ? "agent_chat" : "web";
}

export function normalizeAppAccessMode(value: unknown): "public" | "request" | "targeted" {
  const accessMode = readString(value);
  return accessMode === "request" || accessMode === "targeted" ? accessMode : "public";
}

export function normalizeAppDeploymentProvider(value: unknown): "workspace_ai_cloud" | "cloudflare" | "aws" | "vercel" | "tencent_cloud" | "aliyun" | "replit" | "other" {
  const provider = readString(value);
  return provider === "workspace_ai_cloud" || provider === "cloudflare" || provider === "aws" || provider === "vercel" || provider === "tencent_cloud" || provider === "aliyun" || provider === "replit"
    ? provider
    : "other";
}

export function normalizeAppDeploymentMethod(value: unknown): "docker" | "serverless" | "vps" {
  const method = readString(value);
  return method === "docker" || method === "vps" ? method : "serverless";
}

export function normalizeAppDataRegion(value: unknown): "hong_kong" | "mainland_china" | "singapore" | "north_america" | "other" {
  const region = readString(value);
  return region === "mainland_china" || region === "singapore" || region === "north_america" || region === "other" ? region : "hong_kong";
}

export function normalizeSensitiveDataTypes(value: unknown) {
  const allowed = new Set(["customer_information", "transaction_records", "employee_information", "financial_information", "internal_materials", "public_information"]);
  return readJsonArray(JSON.stringify(Array.isArray(value) ? value : readJsonArray(value)))
    .map((item) => item.trim())
    .filter((item) => allowed.has(item))
    .slice(0, 12);
}

export function normalizeStringList(value: unknown, maxItems: number, maxLength: number) {
  const source = Array.isArray(value) ? value : readJsonArray(value);

  return Array.from(
    new Set(
      source
        .map((item) => readString(item).trim().slice(0, maxLength))
        .filter(Boolean)
    )
  ).slice(0, maxItems);
}

export function normalizeListingType(value: unknown): PublicationSubmissionTargetType {
  const type = readString(value);
  return type === "app" ? "app" : "skill";
}

export function normalizeAssetLifecycleStatus(value: unknown): "pending_review" | "listed" | "delisted" | "deleted" {
  const status = readString(value);

  return status === "listed" || status === "delisted" || status === "deleted" ? status : "pending_review";
}

export function normalizeAssetRiskLevel(value: unknown): "low" | "medium" | "high" {
  const riskLevel = readString(value);

  return riskLevel === "high" || riskLevel === "medium" ? riskLevel : "low";
}

export function normalizeReviewNote(value: unknown) {
  return readString(value).trim().slice(0, 2000);
}

export function normalizePublicationStatus(value: unknown): "pending_review" | "listed" | "delisted" | "deleted" {
  return normalizeAssetLifecycleStatus(value);
}

export function normalizePublicationVisibility(value: unknown): "org" | "team" | "private" {
  const visibility = readString(value);
  return visibility === "team" || visibility === "private" || visibility === "org" ? visibility : "org";
}

export function normalizeTargetPlane(value: unknown): "apps" | "portal" {
  return readString(value) === "portal" ? "portal" : "apps";
}

export function normalizePublicationArtifactType(value: unknown, targetType: PublicationSubmissionTargetType): "skill_md" | "app_config" | "document" | "package" {
  const artifactType = readString(value);
  if (artifactType === "skill_md" || artifactType === "app_config" || artifactType === "document" || artifactType === "package") {
    return artifactType;
  }

  if (targetType === "app") {
    return "app_config";
  }
  return "package";
}

export function normalizeInstallType(value: unknown): "user" | "team" | "download" | "bookmark" {
  const type = readString(value);
  return type === "team" || type === "download" || type === "bookmark" ? type : "user";
}

export function normalizeVersion(value: unknown) {
  const version = readString(value).trim();
  return /^\d+\.\d+\.\d+([-.][a-zA-Z0-9.]+)?$/.test(version) ? version.slice(0, 40) : "1.0.0";
}

export function normalizeUnknownObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return readJsonObject(value);
}

export function hasValidPublicationCoverImage(value: unknown) {
  const imageUrl = readString(value).trim();
  if (!imageUrl) {
    return false;
  }

  if (/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/]+=*$/i.test(imageUrl)) {
    return true;
  }

  if (imageUrl.startsWith("/assets/") || imageUrl.startsWith("/api/forum/media/")) {
    return true;
  }

  try {
    const url = new URL(imageUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function normalizeAppReviewMetadata(input: AppReviewMetadataInput, deps: AppReviewMetadataDeps) {
  const nameZh = deps.optionalText(input.nameZh, 160);
  const nameEn = deps.optionalText(input.nameEn, 160);
  const name = nameEn || nameZh || deps.requireText(input.subtitle, "missing_app_name", 160);
  const descriptionZh = deps.optionalText(input.descriptionZh, 3000);
  const descriptionEn = deps.optionalText(input.descriptionEn, 3000);
  const description = deps.optionalText(input.description, 3000) || descriptionEn || descriptionZh || deps.requireText(input.subtitle, "missing_app_description", 3000);
  const coverImageUrl = deps.normalizeAssetImageUrl(input.coverImageUrl);
  const callbackUrl = readOptionalString(input.callbackUrl)
    ? deps.assertHttpUrl(readString(input.callbackUrl), "invalid_callback_url").toString().slice(0, 600)
    : "";

  return {
    name,
    nameZh,
    nameEn,
    subtitle: deps.optionalText(input.subtitle, 240),
    appType: normalizeAppType(input.appType),
    description,
    descriptionZh,
    descriptionEn,
    launchUrl: deps.assertHttpUrl(deps.requireText(input.launchUrl, "missing_launch_url", 600), "invalid_launch_url").toString().slice(0, 600),
    callbackUrl,
    coverImageUrl,
    screenshots: coverImageUrl ? [coverImageUrl] : [],
    version: deps.optionalText(input.version, 80) || "1.0.0",
    changelog: deps.optionalText(input.changelog, 2000),
    accessMode: normalizeAppAccessMode(input.accessMode),
    accessTargets: normalizeStringList(input.accessTargets, 24, 160),
    usesWorkspaceAuth: input.usesWorkspaceAuth === true,
    deploymentType: normalizeLegacyAppDeploymentType(input.deploymentType),
    deploymentProvider: normalizeAppDeploymentProvider(input.deploymentProvider),
    deploymentMethod: normalizeAppDeploymentMethod(input.deploymentMethod),
    dataRegion: normalizeAppDataRegion(input.dataRegion),
    model: deps.optionalText(input.model, 240),
    modelProvider: deps.optionalText(input.modelProvider, 240),
    dataTypes: normalizeStringList(input.dataTypes, 24, 160),
    sensitiveDataTypes: normalizeSensitiveDataTypes(input.sensitiveDataTypes),
    knowledgeSources: normalizeStringList(input.knowledgeSources, 24, 240),
    userScope: appUserScopeFromAccessMode(input.accessMode),
    riskReason: deps.optionalText(input.riskReason, 2000),
    permissionNotes: deps.optionalText(input.permissionNotes, 2000),
    outputNotes: deps.optionalText(input.outputNotes, 2000)
  };
}

export function normalizeLegacyAppDeploymentType(value: unknown): "saas" | "private" | "serverless" {
  const type = readString(value);
  return type === "private" || type === "serverless" ? type : "saas";
}

export function appUserScopeFromAccessMode(value: unknown): "all" | "department" | "management" | "custom" {
  const accessMode = normalizeAppAccessMode(value);

  if (accessMode === "public") {
    return "all";
  }

  return "custom";
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

function readJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readJsonArray(value: unknown) {
  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}
