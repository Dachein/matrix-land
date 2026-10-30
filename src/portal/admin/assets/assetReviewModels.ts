import type { AppSensitiveDataType, AssetLifecycleStatus, DataService, PublicationListing, PortalApp, PortalCatalog, Skill } from "../../../shared/types";
import { normalizeMarketCategoryName } from "../../../shared/marketCategories";
import { publicationOwnerLabel, portalAppOwnerName } from "../../market/ownerDisplay";
import type { AppReviewDraft, AssetDetailRow, AssetRiskLevel, ManagedAsset, Translate } from "./types";

export function appReviewDraftFromAsset(asset: ManagedAsset): AppReviewDraft {
  const app = asset.app;
  const listing = asset.listing;
  const draft = publicationListingReviewDraft(listing);
  const coverImageUrl = listing?.coverImageUrl || readDraftString(draft, "coverImageUrl", app?.coverImageUrl || app?.screenshots?.[0] || "");

  return {
    appType: readAppType(draft, "appType", app?.appType ?? "web"),
    category: normalizeMarketCategoryName(listing?.category || app?.category || readDraftString(draft, "category", "Workflow"), "workflow"),
    nameZh: readDraftString(draft, "nameZh", app?.nameZh || app?.name || listing?.name || ""),
    nameEn: readDraftString(draft, "nameEn", app?.nameEn || app?.name || ""),
    subtitle: readDraftString(draft, "subtitle", app?.subtitle || listing?.summary || ""),
    descriptionZh: readDraftString(draft, "descriptionZh", app?.descriptionZh || app?.description || listing?.description || ""),
    descriptionEn: readDraftString(draft, "descriptionEn", app?.descriptionEn || app?.description || ""),
    description: readDraftString(draft, "description", app?.description || listing?.description || ""),
    launchUrl: readDraftString(draft, "launchUrl", app?.launchUrl || ""),
    callbackUrl: app?.callbackUrl || "",
    coverImageUrl,
    screenshots: coverImageUrl ? [coverImageUrl] : [],
    version: listing?.listedVersionId || readDraftString(draft, "version", listing?.reviewVersionId || app?.version || "1.0.0"),
    changelog: readDraftString(draft, "changelog", app?.changelog || ""),
    pageVisibility: readDraftString(draft, "pageVisibility", ""),
    loginRequired: readDraftBoolean(draft, "loginRequired", readDraftBoolean(draft, "usesWorkspaceAuth", app?.usesWorkspaceAuth ?? true)),
    accessMode: readAccessMode(draft, "accessMode", app?.accessMode ?? "public"),
    accessTargets: readStringList(draft, "accessTargets", app?.accessTargets ?? []),
    usesWorkspaceAuth: readDraftBoolean(draft, "usesWorkspaceAuth", app?.usesWorkspaceAuth ?? true),
    deploymentType: readDeploymentType(draft, "deploymentType", app?.deploymentType ?? "saas"),
    deploymentProvider: readDeploymentProvider(draft, "deploymentProvider", app?.deploymentProvider ?? "other"),
    deploymentMethod: readDeploymentMethod(draft, "deploymentMethod", app?.deploymentMethod ?? "serverless"),
    dataRegion: readDataRegion(draft, "dataRegion", app?.dataRegion ?? "hong_kong"),
    model: readDraftString(draft, "model", app?.model || ""),
    modelProvider: readDraftString(draft, "modelProvider", app?.modelProvider || ""),
    dataTypes: readStringList(draft, "dataTypes", app?.dataTypes ?? []),
    sensitiveDataTypes: readSensitiveDataTypes(draft, "sensitiveDataTypes", app?.sensitiveDataTypes ?? []),
    knowledgeSources: readStringList(draft, "knowledgeSources", app?.knowledgeSources ?? []),
    riskReason: readDraftString(draft, "riskReason", app?.riskReason || ""),
    permissionNotes: readDraftString(draft, "permissionNotes", app?.permissionNotes || ""),
    outputNotes: readDraftString(draft, "outputNotes", app?.outputNotes || "")
  };
}

export function buildManagedAssets(catalog: PortalCatalog, t: Translate): ManagedAsset[] {
  const publicationByTarget = publicationListingsByTarget(catalog.publicationListings);
  const entityTargets = new Set([
    ...catalog.apps.map((app) => `portal:app:${app.id}`),
    ...catalog.skills.map((skill) => `portal:skill:${skill.id}`)
  ]);

  return [
    ...catalog.apps.map((app) => appAsset(app, t, publicationByTarget.get(`portal:app:${app.id}`))),
    ...catalog.skills.map((skill) => skillAsset(skill, t, publicationByTarget.get(`portal:skill:${skill.id}`))),
    ...catalog.dataServices.map((service) => mcpAsset(service, t)),
    ...catalog.publicationListings
      .filter((listing) => !entityTargets.has(`${listing.targetPlane ?? "portal"}:${listing.type}:${listing.targetId}`))
      .map((listing) => publicationListingAsset(listing, t))
  ].sort((left, right) => {
    const statusRank = lifecycleRank(left.status) - lifecycleRank(right.status);
    return statusRank || left.type.localeCompare(right.type) || left.name.localeCompare(right.name);
  });
}

function appAsset(app: PortalApp, t: Translate, listing?: PublicationListing): ManagedAsset {
  const appDraft = appReviewDraftFromAsset({
    id: app.id,
    type: "app",
    app,
    listing,
    name: app.name,
    owner: portalAppOwnerName(app),
    category: app.category,
    description: app.description,
    status: app.status,
    risk: app.riskLevel,
    primaryMetric: "",
    secondaryMetric: "",
    metaRows: [],
    securityRows: [],
    updatedAt: app.updatedAt
  });
  const status = listing?.status ?? app.status;
  const risk = listing?.riskLevel ?? app.riskLevel;

  return {
    id: app.id,
    type: "app",
    app,
    listing,
    coverImageUrl: appDraft.coverImageUrl,
    marketCategory: listing?.category || app.category,
    name: listing?.name || appDraft.nameZh || app.name,
    owner: listing ? publicationOwnerLabel(listing, "-") : portalAppOwnerName(app),
    category: `${listing?.category || app.category}${listing?.targetPlane === "apps" ? " / APPS" : ""}`,
    description: listing?.summary || appDraft.subtitle || app.subtitle || app.description,
    status,
    risk,
    primaryMetric: t("admin.assets.appPrimaryMetric", { views: app.viewCount.toLocaleString(), launches: app.launchCount.toLocaleString() }),
    secondaryMetric: listing
      ? `${listing.targetPlane ?? "portal"} / ${listing.listedVersionId || listing.reviewVersionId || app.version}`
      : t("admin.assets.appSecondaryMetric", { likes: app.likeCount.toLocaleString(), discussions: app.discussionCount.toLocaleString() }),
    metaRows: [
      { label: t("apps.publish.nameZh"), value: appDraft.nameZh || app.name },
      { label: t("apps.publish.nameEn"), value: appDraft.nameEn || "-" },
      { label: t("apps.publish.version"), value: appDraft.version || "-" },
      { label: t("apps.publish.category"), value: normalizeMarketCategoryName(appDraft.category, "workflow") },
      { label: t("apps.publish.subtitle"), value: appDraft.subtitle || "-", wide: true },
      { label: t("apps.publish.descriptionZh"), value: appDraft.descriptionZh || "-", wide: true },
      { label: t("apps.publish.descriptionEn"), value: appDraft.descriptionEn || "-", wide: true },
      { label: t("apps.publish.changelog"), value: appDraft.changelog || "-", wide: true },
      { label: t("admin.assets.appType"), value: appDraft.appType },
      { label: t("admin.assets.model"), value: appDraft.model || "-" },
      { label: t("apps.publish.modelProvider"), value: appDraft.modelProvider || "-" },
      { label: t("apps.publish.deploymentProvider"), value: deploymentProviderLabel(appDraft.deploymentProvider, t) },
      ...(appDraft.deploymentProvider === "workspace_ai_cloud" ? [] : [
        { label: t("admin.assets.deploymentType"), value: `${appDraft.deploymentType} / ${deploymentMethodLabel(appDraft.deploymentMethod, t)}` },
        { label: t("apps.publish.dataRegion"), value: dataRegionLabel(appDraft.dataRegion, t) },
        { label: t("apps.publish.deploymentMethod"), value: deploymentMethodLabel(appDraft.deploymentMethod, t) }
      ]),
      { label: t("apps.publish.accessMode"), value: appAccessSummary(appDraft, t) },
      { label: t("admin.assets.workspaceAuth"), value: appDraft.usesWorkspaceAuth ? t("apps.publish.authUse") : t("apps.publish.authNotUse") },
      { label: t("admin.assets.sdk"), value: app.sdkStatus },
      { label: t("admin.assets.appUrl"), value: appDraft.launchUrl || "-", href: safeAssetHref(appDraft.launchUrl), wide: true },
      { label: t("admin.assets.callback"), value: app.callbackUrl || "-", wide: true }
    ],
    securityRows: [
      { label: t("apps.publish.riskLevel"), value: riskLabel(risk, t) },
      { label: t("apps.publish.tags"), value: formatAssetList(listing?.tags ?? app.tags), wide: true },
      { label: t("apps.publish.sensitiveData"), value: formatSensitiveDataList(appDraft.sensitiveDataTypes, t), wide: true },
      { label: t("admin.assets.scopes"), value: formatAssetList(app.scopes), wide: true },
      { label: t("apps.publish.riskReason"), value: appDraft.riskReason || "-", wide: true },
      { label: t("apps.publish.permissionNotes"), value: appDraft.permissionNotes || "-", wide: true },
      { label: t("apps.publish.outputNotes"), value: appDraft.outputNotes || "-", wide: true }
    ],
    reviewNotes: listing?.reviewNotes ?? app.reviewNotes,
    updatedAt: listing?.updatedAt ?? app.updatedAt
  };
}

function skillAsset(skill: Skill, t: Translate, listing?: PublicationListing): ManagedAsset {
  const risk = listing?.riskLevel ?? skillRisk(skill);
  const kind = skillKindLabel(skill, t);
  const packageRow = listing ? skillPackageRow(listing, t) : undefined;
  const reviewDraft = publicationListingReviewDraft(listing);
  const version = listing?.listedVersionId || readDraftString(reviewDraft, "version", listing?.reviewVersionId || skill.version);

  return {
    id: skill.id,
    type: "skill",
    listing,
    coverImageUrl: listing?.coverImageUrl || readDraftString(reviewDraft, "coverImageUrl", skill.coverImageUrl || ""),
    marketCategory: listing?.category || skill.category,
    name: listing?.name || skill.name,
    owner: listing ? publicationOwnerLabel(listing, "-") : skill.owner,
    category: `${listing?.category || skill.category} / ${kind}`,
    description: listing?.summary || skill.description,
    status: listing?.status ?? skill.status,
    risk,
    primaryMetric: t("admin.assets.installMetric", { count: skill.installs.toLocaleString() }),
    secondaryMetric: t("admin.assets.discussionVersionMetric", { discussions: skill.discussions.toLocaleString(), version }),
    metaRows: [
      { label: t("admin.assets.skillName"), value: skill.name },
      { label: t("admin.assets.type"), value: kind },
      { label: t("admin.assets.category"), value: listing?.category || skill.category },
      { label: t("common.version"), value: version },
      { label: t("common.installs"), value: skill.installs.toLocaleString() },
      { label: t("common.discussions"), value: skill.discussions.toLocaleString() },
      { label: t("admin.assets.mcpTools"), value: formatAssetList(skill.mcpTools), wide: true },
      { label: t("admin.assets.dependencies"), value: formatAssetList(skill.dependencies), wide: true },
      ...(packageRow ? [packageRow] : [])
    ],
    securityRows: [
      { label: t("admin.assets.riskLevel"), value: riskLabel(risk, t) },
      { label: t("admin.assets.scopes"), value: formatAssetList(skill.scopes), wide: true },
      { label: t("admin.assets.runtime"), value: skillRuntimeLabel(skill, t), wide: true },
      { label: t("admin.assets.reviewNotes"), value: (listing?.reviewNotes ?? skill.reviewNotes) || "-", wide: true }
    ],
    reviewNotes: listing?.reviewNotes ?? skill.reviewNotes,
    updatedAt: listing?.updatedAt ?? skill.updatedAt
  };
}

function mcpAsset(service: DataService, t: Translate): ManagedAsset {
  return {
    id: service.id,
    type: "mcp",
    name: service.name,
    owner: service.owner,
    category: "MCP",
    description: service.description,
    status: service.status,
    risk: service.risk,
    primaryMetric: t("admin.assets.callsMetric", { count: service.monthlyCalls.toLocaleString() }),
    secondaryMetric: t("admin.assets.toolsSkillsMetric", { tools: service.tools.length, skills: service.boundSkills.length }),
    metaRows: [
      { label: t("admin.assets.mcpServer"), value: service.name },
      { label: t("admin.assets.endpoint"), value: service.endpoint, wide: true },
      { label: t("admin.assets.owner"), value: service.owner },
      { label: t("admin.assets.freshness"), value: service.freshness },
      { label: t("admin.assets.monthlyCalls"), value: service.monthlyCalls.toLocaleString() },
      { label: t("admin.assets.tools"), value: formatAssetList(service.tools), wide: true },
      { label: t("admin.assets.boundSkills"), value: formatAssetList(service.boundSkills), wide: true }
    ],
    securityRows: [
      { label: t("admin.assets.riskLevel"), value: riskLabel(service.risk, t) },
      { label: t("admin.assets.scopes"), value: formatAssetList(service.scopes), wide: true },
      { label: t("admin.assets.reviewNotes"), value: service.reviewNotes || "-", wide: true }
    ],
    reviewNotes: service.reviewNotes,
    updatedAt: service.freshness
  };
}

function publicationListingAsset(listing: PublicationListing, t: Translate): ManagedAsset {
  const risk = listing.riskLevel ?? "low";
  const reviewDraft = publicationListingReviewDraft(listing);
  const draftMetaRows = publicationListingDraftMetaRows(listing, reviewDraft, t);
  const draftSecurityRows = publicationListingDraftSecurityRows(listing, reviewDraft, t);

  return {
    id: listing.id,
    type: listing.type,
    listing,
    coverImageUrl: listing.coverImageUrl || readDraftString(reviewDraft, "coverImageUrl", ""),
    marketCategory: listing.category,
    name: listing.name,
    owner: publicationOwnerLabel(listing, "-"),
    category: `${listing.category} / ${listing.targetPlane === "apps" ? "APPS" : "Portal"}`,
    description: listing.summary || listing.description,
    status: listing.status,
    risk,
    primaryMetric: listing.type === "app"
      ? t("admin.assets.visitMetric", { count: (listing.visitCount ?? 0).toLocaleString() })
      : t("admin.assets.usageMetric", {
        count: ((listing.agentAddCount ?? 0) + (listing.downloadCount ?? listing.installs)).toLocaleString()
      }),
    secondaryMetric: `${listing.targetPlane ?? "portal"} / ${listing.reviewVersionId || listing.listedVersionId || t("admin.assets.unversioned")}`,
    metaRows: [
      { label: t("admin.assets.listingId"), value: listing.id, wide: true },
      { label: t("admin.assets.target"), value: `${listing.type}:${listing.targetId}`, wide: true },
      { label: t("admin.assets.plane"), value: listing.targetPlane ?? "portal" },
      { label: t("admin.assets.reviewVersion"), value: listing.reviewVersionId || "-" },
      { label: t("admin.assets.listedVersion"), value: listing.listedVersionId || "-" },
      { label: t("admin.assets.category"), value: listing.category },
      ...(listing.type === "skill" ? [skillPackageRow(listing, t)] : []),
      ...draftMetaRows
    ],
    securityRows: [
      { label: t("apps.publish.riskLevel"), value: riskLabel(risk, t) },
      { label: t("admin.assets.visibility"), value: publicationVisibilityLabel(listing.visibility, t) },
      { label: t("apps.publish.tags"), value: formatAssetList(listing.tags), wide: true },
      ...draftSecurityRows,
      { label: t("admin.assets.reviewNotes"), value: listing.reviewNotes || "-", wide: true }
    ],
    reviewNotes: listing.reviewNotes,
    updatedAt: listing.updatedAt
  };
}

function publicationListingReviewDraft(listing?: PublicationListing) {
  const draft = listing?.config?.reviewDraft;
  return draft && typeof draft === "object" && !Array.isArray(draft) ? draft as Record<string, unknown> : {};
}

function publicationListingDraftMetaRows(listing: PublicationListing, draft: Record<string, unknown>, t: Translate): AssetDetailRow[] {
  if (listing.targetPlane !== "apps") {
    return [];
  }

  if (listing.type === "app") {
    const launchUrl = draftValue(draft, "launchUrl", "");
    const harnessReportUrl = draftValue(draft, "harnessReportUrl", "");
    return compactAssetRows([
      { label: t("apps.publish.nameZh"), value: draftValue(draft, "nameZh", listing.name) },
      { label: t("apps.publish.nameEn"), value: draftValue(draft, "nameEn", "-") },
      { label: t("apps.publish.version"), value: draftValue(draft, "version", listing.reviewVersionId || "-") },
      { label: t("apps.publish.category"), value: normalizeMarketCategoryName(draftValue(draft, "category", listing.category), "workflow") },
      { label: t("apps.publish.subtitle"), value: draftValue(draft, "subtitle", listing.summary), wide: true },
      { label: t("apps.publish.descriptionZh"), value: draftValue(draft, "descriptionZh", listing.description), wide: true },
      { label: t("apps.publish.descriptionEn"), value: draftValue(draft, "descriptionEn", "-"), wide: true },
      { label: t("apps.publish.changelog"), value: draftValue(draft, "changelog", "-"), wide: true },
      { label: t("admin.assets.launchUrl"), value: launchUrl || "-", href: safeAssetHref(launchUrl), wide: true },
      { label: t("apps.publish.harnessReportUrl"), value: harnessReportUrl || "-", href: safeAssetHref(harnessReportUrl), wide: true },
      { label: t("apps.publish.harnessSelfCheck"), value: readDraftBoolean(draft, "harnessSelfCheckConfirmed", false) ? t("apps.publish.selfCheckConfirmed") : t("apps.publish.selfCheckNotConfirmed") },
      { label: t("apps.publish.accessMode"), value: draftAccessSummary(draft, t) },
      { label: t("admin.assets.workspaceAuth"), value: draftAuthLabel(draft, t) },
      { label: t("apps.publish.deploymentProvider"), value: draftDeploymentProviderLabel(draft, t) },
      ...(draftValue(draft, "deploymentProvider", "-") === "workspace_ai_cloud" ? [] : [
        { label: t("apps.publish.dataRegion"), value: draftDataRegionLabel(draft, t) },
        { label: t("apps.publish.deploymentMethod"), value: draftDeploymentMethodLabel(draft, t) }
      ]),
      { label: t("apps.publish.modelProvider"), value: draftValue(draft, "modelProvider", "-") }
    ]);
  }

  if (listing.type === "skill") {
    return compactAssetRows([
      { label: t("admin.assets.skillName"), value: draftValue(draft, "name", listing.name), wide: true },
      { label: t("common.version"), value: draftValue(draft, "version", listing.reviewVersionId || "-") },
      { label: t("admin.assets.installNotes"), value: draftValue(draft, "installNotes", "-"), wide: true }
    ]);
  }

  return [];
}

function skillPackageRow(listing: PublicationListing, t: Translate): AssetDetailRow {
  return {
    download: true,
    href: `/api/listings/${encodeURIComponent(listing.id)}/download?source=admin_review`,
    label: t("apps.detail.downloadSkill"),
    value: t("apps.detail.downloadSkill"),
    wide: true
  };
}

function safeAssetHref(value: string | undefined) {
  const href = value?.trim();
  if (!href) {
    return undefined;
  }

  try {
    const url = new URL(href, "https://portal.example-org.invalid");
    return url.protocol === "http:" || url.protocol === "https:" ? href : undefined;
  } catch {
    return undefined;
  }
}

function publicationListingDraftSecurityRows(listing: PublicationListing, draft: Record<string, unknown>, t: Translate): AssetDetailRow[] {
  if (listing.targetPlane !== "apps") {
    return [];
  }

  if (listing.type === "app") {
    return compactAssetRows([
      { label: t("apps.publish.sensitiveData"), value: draftSensitiveDataValue(draft, t), wide: true },
      { label: t("apps.publish.riskReason"), value: draftValue(draft, "riskReason", "-"), wide: true },
      { label: t("apps.publish.permissionNotes"), value: draftValue(draft, "permissionNotes", "-"), wide: true },
      { label: t("apps.publish.outputNotes"), value: draftValue(draft, "outputNotes", "-"), wide: true }
    ]);
  }

  if (listing.type === "skill") {
    return compactAssetRows([
      { label: t("admin.assets.riskReason"), value: draftValue(draft, "riskReason", "-"), wide: true },
      { label: t("admin.assets.publishTags"), value: draftListValue(draft, "tags"), wide: true }
    ]);
  }

  return [];
}

function draftValue(draft: Record<string, unknown>, key: string, fallback = "-") {
  const value = draft[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function riskLabel(value: string, t: Translate) {
  if (value === "high") {
    return t("apps.publish.riskHigh");
  }

  if (value === "medium") {
    return t("apps.publish.riskMedium");
  }

  return t("apps.publish.riskLow");
}

function visibilityLabel(value: string, t: Translate) {
  const labels: Record<string, string> = {
    company: t("apps.visibility.company"),
    org: t("apps.visibility.org"),
    private: t("apps.visibility.private"),
    public: t("apps.visibility.public"),
    team: t("apps.visibility.team")
  };

  return labels[value] ?? (value || "-");
}

function loginLabel(required: boolean, t: Translate) {
  return required ? t("apps.login.required") : t("apps.login.notRequired");
}

function appAccessSummary(draft: AppReviewDraft, t: Translate) {
  const loginRequired = draft.loginRequired ?? draft.usesWorkspaceAuth;
  const visibility = draft.pageVisibility || fallbackVisibility(draft.accessMode, loginRequired);
  return `${visibilityLabel(visibility, t)} / ${loginLabel(loginRequired, t)}`;
}

function draftAccessSummary(draft: Record<string, unknown>, t: Translate) {
  const loginRequired = readDraftBooleanValue(draft, "loginRequired") ?? readDraftBooleanValue(draft, "usesWorkspaceAuth") ?? (draftValue(draft, "accessMode", "public") !== "public");
  const visibility = draftValue(draft, "pageVisibility", "") || fallbackVisibility(draftValue(draft, "accessMode", "public"), loginRequired);
  return `${visibilityLabel(visibility, t)} / ${loginLabel(loginRequired, t)}`;
}

function fallbackVisibility(accessMode: string, loginRequired: boolean) {
  if (accessMode === "targeted") {
    return "team";
  }

  if (accessMode === "request") {
    return "org";
  }

  return loginRequired ? "org" : "public";
}

function draftAuthLabel(draft: Record<string, unknown>, t: Translate) {
  const value = readDraftBooleanValue(draft, "usesWorkspaceAuth");
  return typeof value === "boolean" ? (value ? t("apps.publish.authUse") : t("apps.publish.authNotUse")) : "-";
}

function readDraftBooleanValue(draft: Record<string, unknown>, key: string) {
  const value = draft[key];
  return typeof value === "boolean" ? value : undefined;
}

function deploymentProviderLabel(value: string, t: Translate) {
  const labels: Record<string, string> = {
    aliyun: t("apps.publish.aliyun"),
    aws: t("apps.publish.providerAws"),
    cloudflare: t("apps.publish.providerCloudflare"),
    workspace_ai_cloud: t("apps.publish.providerWorkspaceAiCloud"),
    other: t("apps.publish.other"),
    replit: t("apps.publish.providerReplit"),
    tencent_cloud: t("apps.publish.tencentCloud"),
    vercel: t("apps.publish.providerVercel")
  };

  return labels[value] ?? (value || "-");
}

function draftDeploymentProviderLabel(draft: Record<string, unknown>, t: Translate) {
  const value = draftValue(draft, "deploymentProvider", "");
  return value ? deploymentProviderLabel(value, t) : "-";
}

function deploymentMethodLabel(value: string, t: Translate) {
  const labels: Record<string, string> = {
    docker: t("apps.publish.methodDocker"),
    serverless: t("apps.publish.methodServerless"),
    vps: t("apps.publish.methodVps")
  };

  return labels[value] ?? (value || "-");
}

function draftDeploymentMethodLabel(draft: Record<string, unknown>, t: Translate) {
  return deploymentMethodLabel(draftValue(draft, "deploymentMethod", ""), t);
}

function dataRegionLabel(value: string, t: Translate) {
  const labels: Record<string, string> = {
    hong_kong: t("apps.publish.regionHongKong"),
    mainland_china: t("apps.publish.regionMainland"),
    north_america: t("apps.publish.regionNorthAmerica"),
    other: t("apps.publish.other"),
    singapore: t("apps.publish.regionSingapore")
  };

  return labels[value] ?? (value || "-");
}

function draftDataRegionLabel(draft: Record<string, unknown>, t: Translate) {
  return dataRegionLabel(draftValue(draft, "dataRegion", ""), t);
}

function formatSensitiveDataList(values: string[] | undefined, t: Translate) {
  return formatAssetList(values?.map((value) => sensitiveDataValue(value, t)));
}

function draftSensitiveDataValue(draft: Record<string, unknown>, t: Translate) {
  return formatSensitiveDataList(readStringList(draft, "sensitiveDataTypes"), t);
}

function sensitiveDataValue(value: string, t: Translate) {
  if (!isSensitiveDataType(value)) {
    return value;
  }

  const labels: Record<AppSensitiveDataType, string> = {
    customer_information: t("apps.sensitive.customer"),
    employee_information: t("apps.sensitive.employee"),
    financial_information: t("apps.sensitive.financial"),
    internal_materials: t("apps.sensitive.internal"),
    public_information: t("apps.sensitive.public"),
    transaction_records: t("apps.sensitive.transactions")
  };

  return labels[value];
}

function isSensitiveDataType(value: string): value is AppSensitiveDataType {
  return value === "customer_information" ||
    value === "transaction_records" ||
    value === "employee_information" ||
    value === "financial_information" ||
    value === "internal_materials" ||
    value === "public_information";
}

function publicationVisibilityLabel(value: string, t: Translate) {
  return visibilityLabel(value === "company" ? "org" : value, t);
}

function draftListValue(draft: Record<string, unknown>, key: string) {
  const value = draft[key];

  if (Array.isArray(value)) {
    const list = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return formatAssetList(list);
  }

  if (typeof value === "string") {
    return value || "-";
  }

  return "-";
}

function compactAssetRows(rows: AssetDetailRow[]) {
  return rows;
}

function publicationListingsByTarget(listings: PublicationListing[]) {
  const byTarget = new Map<string, PublicationListing>();

  for (const listing of listings) {
    const key = `${listing.targetPlane ?? "portal"}:${listing.type}:${listing.targetId}`;
    const current = byTarget.get(key);
    if (!current || publicationListingRank(listing) < publicationListingRank(current)) {
      byTarget.set(key, listing);
    }
  }

  return byTarget;
}

function publicationListingRank(listing: PublicationListing) {
  if (listing.status === "pending_review") {
    return 0;
  }

  if (listing.status === "listed") {
    return 1;
  }

  return 2;
}

function readDraftString(draft: Record<string, unknown>, key: string, fallback = "") {
  const value = draft[key];
  return typeof value === "string" ? value : fallback;
}

function readDraftBoolean(draft: Record<string, unknown>, key: string, fallback: boolean) {
  const value = draft[key];
  return typeof value === "boolean" ? value : fallback;
}

function readStringList(draft: Record<string, unknown>, key: string, fallback: string[] = []) {
  const value = draft[key];

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  return fallback;
}

function readAppType(draft: Record<string, unknown>, key: string, fallback: AppReviewDraft["appType"]) {
  const value = draft[key];
  return value === "agent_chat" || value === "web" ? value : fallback;
}

function readAccessMode(draft: Record<string, unknown>, key: string, fallback: AppReviewDraft["accessMode"]) {
  const value = draft[key];
  return value === "request" || value === "targeted" || value === "public" ? value : fallback;
}

function readDeploymentType(draft: Record<string, unknown>, key: string, fallback: AppReviewDraft["deploymentType"]) {
  const value = draft[key];
  return value === "saas" || value === "private" || value === "serverless" ? value : fallback;
}

function readDeploymentProvider(draft: Record<string, unknown>, key: string, fallback: AppReviewDraft["deploymentProvider"]) {
  const value = draft[key];
  return value === "workspace_ai_cloud" || value === "cloudflare" || value === "aws" || value === "vercel" || value === "tencent_cloud" || value === "aliyun" || value === "replit" || value === "other"
    ? value
    : fallback;
}

function readDeploymentMethod(draft: Record<string, unknown>, key: string, fallback: AppReviewDraft["deploymentMethod"]) {
  const value = draft[key];
  return value === "docker" || value === "serverless" || value === "vps" ? value : fallback;
}

function readDataRegion(draft: Record<string, unknown>, key: string, fallback: AppReviewDraft["dataRegion"]) {
  const value = draft[key];
  return value === "hong_kong" || value === "mainland_china" || value === "singapore" || value === "north_america" || value === "other"
    ? value
    : fallback;
}

function readSensitiveDataTypes(draft: Record<string, unknown>, key: string, fallback: AppSensitiveDataType[]) {
  const allowed = new Set<AppSensitiveDataType>([
    "customer_information",
    "transaction_records",
    "employee_information",
    "financial_information",
    "internal_materials",
    "public_information"
  ]);
  const values = readStringList(draft, key).filter((item): item is AppSensitiveDataType => allowed.has(item as AppSensitiveDataType));
  return values.length > 0 ? values : fallback;
}

function skillRisk(skill: Skill): AssetRiskLevel {
  if (skill.riskLevel) {
    return skill.riskLevel;
  }

  if (skill.scopes.some((scope) => scope.includes(":write") || scope.includes(".write"))) {
    return "high";
  }

  return skill.mcpTools.length > 0 || skill.dependencies.length > 0 || skill.scopes.length > 1 ? "medium" : "low";
}

function skillKindLabel(skill: Skill, t: Translate) {
  if (skill.kind === "knowledge") {
    return t("ui.kind.knowledge");
  }
  if (skill.kind === "app") {
    return t("ui.kind.app");
  }
  return t("ui.kind.vanilla");
}

function skillRuntimeLabel(skill: Skill, t: Translate) {
  if (skill.kind === "knowledge") {
    return "Workspace Knowledge read-only adapter";
  }
  if (skill.kind === "app") {
    return "Workspace App API adapter";
  }
  if (skill.mcpTools.length > 0 || skill.dependencies.length > 0) {
    return t("admin.assets.runtimeMcp");
  }
  return t("admin.assets.runtimePure");
}

function formatAssetList(values: string[] | undefined) {
  return values && values.length > 0 ? values.join(", ") : "-";
}

export function assetSummary(assets: ManagedAsset[]) {
  return {
    total: assets.length,
    pending: assets.filter((asset) => asset.status === "pending_review").length,
    listed: assets.filter((asset) => asset.status === "listed").length,
    highRisk: assets.filter((asset) => asset.risk === "high").length
  };
}

function lifecycleRank(status: AssetLifecycleStatus) {
  if (status === "pending_review") {
    return 0;
  }

  if (status === "listed") {
    return 1;
  }

  if (status === "delisted") {
    return 2;
  }

  return 3;
}
