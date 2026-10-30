import type { AppsApp, AppsDomain, AppsResource, AppsSkill, PublicationListing, PortalCatalog } from "../../shared/types";
import { appsDomainResourceLabel, appsEnvironmentLabel, appsMarketStatusLabel, appsResourceLabel, appsResourceStatusLabel, type AppsTFunction } from "./labels";
import type { AppsAppInfoInput, AppsDetailRow, AppsDevelopmentResourceItem, AppsProductItem, AppsProductProgressState, AppsProductProgressStep, AppsSkillInfoInput } from "./types";
import { isPlainRecord, readDraftString, reviewDraftFromListing } from "./productPublishDraftModels";

export { appPublishDraftFromProduct, emptyAppPublishDraft, emptySkillPublishDraft, skillPublishDraftFromProduct } from "./productPublishDraftModels";
export { appsSkillProjectStructureModel } from "./productSkillStructureModels";

export function appsProductBasicInfoRows(product: AppsProductItem, listing: PublicationListing | undefined, t: AppsTFunction): AppsDetailRow[] {
  if (product.app) {
    const app = product.app;
    return [
      { format: "primary", label: t("apps.field.name"), span: 7, value: app.name },
      { format: "code", label: t("apps.field.appCode"), span: 5, value: app.appCode || app.slug },
      { label: t("apps.field.productionDomain"), value: app.productionUrl, href: app.productionUrl, span: 12 as const },
      { format: "prose", label: t("apps.field.note"), span: 12, value: app.description || "-" }
    ];
  }

  if (product.appsSkill) {
    const skill = product.appsSkill;
    return [
      { format: "primary", label: t("apps.field.name"), span: 5, value: skill.name },
      { format: "code", label: t("apps.field.skillSlug"), span: 4, value: skill.slug },
      { format: "code", label: t("apps.field.currentVersion"), span: 3, value: skill.currentVersion || "1.0.0" },
      { format: "prose", label: t("apps.field.note"), span: 12, value: skill.description || "-" },
      { format: "tags", label: t("apps.field.capabilityTags"), span: 12, value: formatAppsDetailList(skill.capabilities) }
    ];
  }

  return appsListingBasicInfoRows(product, listing, t);
}

function appsListingBasicInfoRows(product: AppsProductItem, listing: PublicationListing | undefined, t: AppsTFunction): AppsDetailRow[] {
  const draft = reviewDraftFromListing(listing);
  const productionUrl = listingRuntimeUrl(listing, "productionUrl") || readDraftString(draft, "launchUrl", "");
  const displayName = readDraftString(draft, "nameZh", "") || readDraftString(draft, "nameEn", "") || listing?.name || product.name;

  return [
    { format: "primary" as const, label: t("apps.field.name"), span: 7 as const, value: displayName },
    { format: "code" as const, label: product.type === "app" ? t("apps.field.appCode") : t("apps.field.skillSlug"), span: 5 as const, value: codeFromListing(product, listing) },
    ...(productionUrl ? [{ label: t("apps.field.productionDomain"), value: productionUrl, href: productionUrl, span: 12 as const }] : []),
    { format: "prose" as const, label: t("apps.field.note"), span: 12 as const, value: listing?.description || product.subtitle || "-" }
  ];
}

export function appsDevelopmentResourceItems(app: AppsApp | undefined, listing: PublicationListing | undefined, t: AppsTFunction): AppsDevelopmentResourceItem[] {
  if (app) {
    return [
      ...app.resources.filter(resource=>resource.type!=="email_sending"&&resource.type!=="email_routing").map((resource) => ({
        copyValue: resourceClipboardValue(resource, t),
        detail: resource.resourceName,
        environment: appsEnvironmentLabel(resource.environment, t),
        label: resourceFriendlyLabel(resource.type, t),
        state: resourceReadyState(resource.status),
        status: resourceStatusLabel(resource.status, t),
        type: resource.type
      })),
      ...mailDevelopmentResource(app,t),
      ...app.domains.map((domain) => ({
        copyValue: domainClipboardValue(domain, t),
        detail: domain.hostname,
        environment: appsEnvironmentLabel(domain.environment, t),
        label: appsDomainResourceLabel(domain.type, t),
        state: resourceReadyState(domain.status),
        status: resourceStatusLabel(domain.status, t),
        type: `domain_${domain.type}`
      }))
    ].sort((left, right) => resourceSortWeight(left.type) - resourceSortWeight(right.type));
  }

  const productionUrl = listingRuntimeUrl(listing, "productionUrl") || readDraftString(reviewDraftFromListing(listing), "launchUrl", "");
  const items: Array<AppsDevelopmentResourceItem | undefined> = [
    productionUrl ? { detail: productionUrl, environment: appsEnvironmentLabel("production", t), label: appsDomainResourceLabel("production", t), state: "ready", status: t("apps.resource.status.reserved"), type: "domain_production" } : undefined,
    listing ? { detail: listing.id, label: t("apps.resource.marketRecord"), state: resourceReadyState(listing.status), status: marketStatusLabel(listing.status, t), type: "market_listing" } : undefined
  ];

  return items.filter((item): item is AppsDevelopmentResourceItem => Boolean(item));
}

export function appsProductProgressSteps({
  app,
  listing,
  product,
  skill
}: {
  app?: AppsApp;
  listing?: PublicationListing;
  product: AppsProductItem;
  skill?: AppsSkill;
}, t: AppsTFunction) {
  if (app || product.type === "app") {
    const resourcesReady = app ? appDevelopmentResourcesReady(app) : Boolean(listing);
    const productionUrl = app?.productionUrl || listingRuntimeUrl(listing, "productionUrl") || readDraftString(reviewDraftFromListing(listing), "launchUrl", "");
    const appPublished = app
      ? app.status === "published" || app.deployments.some((deployment) => deployment.status.toLowerCase() === "published")
      : Boolean(productionUrl);
    const appDeployed = app
      ? appPublished || app.deployments.some((deployment) => deployment.status.toLowerCase() === "ready")
      : Boolean(productionUrl);
    const market = marketReviewProgress(listing, t);
    const shelf = marketShelfProgress(listing, t);

    return sequentialProgressSteps([
      {
        detail: resourcesReady ? t("apps.progress.resourcesReady") : t("apps.progress.resourcesWaiting"),
        label: t("apps.progress.resourceApplied"),
        state: resourcesReady ? "ready" : "pending"
      },
      {
        detail: appPublished
          ? t("apps.progress.appPublished")
          : appDeployed
            ? t("apps.progress.appPreviewReady")
            : t("apps.progress.appWaitingProduction"),
        label: t("apps.progress.appPublishedLabel"),
        state: appDeployed ? "ready" : resourcesReady ? "pending" : "idle"
      },
      {
        detail: market.detail,
        label: t("apps.progress.marketLabel"),
        state: market.state
      },
      {
        detail: shelf.detail,
        label: shelf.label,
        state: shelf.state
      }
    ]);
  }

  const skillReady = Boolean(skill?.currentVersion || skill?.versions.length || listing);
  const market = marketReviewProgress(listing, t);
  const shelf = marketShelfProgress(listing, t);

  return sequentialProgressSteps([
    {
      detail: skillReady ? t("apps.progress.skillReady") : t("apps.progress.skillWaiting"),
      label: t("apps.progress.skillReadyLabel"),
      state: skillReady ? "ready" : "pending"
    },
    {
      detail: market.detail,
      label: t("apps.progress.marketLabel"),
      state: market.state
    },
    {
      detail: shelf.detail,
      label: shelf.label,
      state: shelf.state
    }
  ]);
}

function sequentialProgressSteps(steps: AppsProductProgressStep[]) {
  let foundCurrentStep = false;

  return steps.map((step): AppsProductProgressStep => {
    if (!foundCurrentStep && step.state === "ready") {
      return step;
    }

    if (!foundCurrentStep) {
      foundCurrentStep = true;
      return { ...step, state: "pending" };
    }

    return { ...step, state: "idle" };
  });
}

export function appDevelopmentResourcesReady(app: AppsApp) {
  const resourceStatuses = app.resources.map((resource) => resource.status);
  const domainStatuses = app.domains.map((domain) => domain.status);
  const routeStatuses = app.domains.map((domain) => domain.routeStatus || domain.status);

  return app.status !== "provisioning"
    && app.resources.length > 0
    && app.domains.length > 0
    && app.domains.every((domain) => !domain.errorCode)
    && [...resourceStatuses, ...domainStatuses].every(isProvisionedStatus)
    // A Pages custom domain remains "initializing" until its first release.
    // The resource package must be copyable before that release so an Agent
    // can build and deploy it in the first place.
    && routeStatuses.every((status) => status === "initializing" || isProvisionedStatus(status));
}

function isProvisionedStatus(status: string) {
  return ["active", "listed", "proxied", "published", "ready", "registered", "reserved"].includes(status);
}

function marketReviewProgress(listing: PublicationListing | undefined, t: AppsTFunction): { detail: string; state: AppsProductProgressState } {
  if (!listing) {
    return { detail: t("apps.progress.notSubmitted"), state: "idle" };
  }

  if (listing.status === "pending_review") {
    return { detail: t("apps.progress.reviewing"), state: "pending" };
  }

  if (listing.status === "listed" || listing.status === "delisted") {
    return { detail: t("apps.progress.approved"), state: "ready" };
  }

  return { detail: marketStatusLabel(listing.status, t), state: "idle" };
}

function marketShelfProgress(listing: PublicationListing | undefined, t: AppsTFunction): { detail: string; label: string; state: AppsProductProgressState } {
  if (!listing) {
    return { detail: t("apps.progress.shelfWaiting"), label: t("apps.progress.shelfWaitingLabel"), state: "idle" };
  }

  if (listing.status === "listed") {
    return { detail: t("apps.progress.shelfVisible"), label: t("apps.progress.shelfListedLabel"), state: "ready" };
  }

  if (listing.status === "delisted") {
    return { detail: t("apps.progress.shelfDelisted"), label: t("apps.progress.shelfDelistedLabel"), state: "idle" };
  }

  if (listing.status === "pending_review") {
    return { detail: t("apps.progress.shelfPendingDefault"), label: t("apps.progress.shelfWaitingLabel"), state: "idle" };
  }

  return { detail: marketStatusLabel(listing.status, t), label: t("apps.progress.shelfWaitingLabel"), state: "idle" };
}

export function appsProductProductionUrl(app: AppsApp | undefined, listing: PublicationListing | undefined) {
  return app?.productionUrl || listingRuntimeUrl(listing, "productionUrl") || readDraftString(reviewDraftFromListing(listing), "launchUrl", "");
}

export function appInfoInputFromApp(app?: AppsApp): AppsAppInfoInput {
  return {
    appCode: app?.appCode || app?.slug || "",
    name: app?.name || "",
    note: app?.description || ""
  };
}

export function skillInfoInputFromSkill(skill?: AppsSkill): AppsSkillInfoInput {
  return {
    capabilities: skill?.capabilities.join(", ") || "",
    description: skill?.description || "",
    kind: skill?.kind ?? "vanilla",
    name: skill?.name || "",
    slug: skill?.slug || ""
  };
}

export function isCurrentAppsOwner(ownerUserId: string, currentUser: PortalCatalog["currentUser"]) {
  return isCurrentAppsAuthor(ownerUserId, [], currentUser);
}

export function isCurrentAppsAuthor(
  ownerUserId: string,
  collaboratorUserIds: string[] | undefined,
  currentUser: PortalCatalog["currentUser"]
) {
  const currentIdentifiers = new Set([
    currentUser.id,
    currentUser.email,
    currentUser.identity?.objectId,
    currentUser.identity?.principalName
  ].map(normalizeAppsOwnerIdentifier).filter(Boolean));

  return [ownerUserId, ...(collaboratorUserIds ?? [])]
    .some((identifier) => currentIdentifiers.has(normalizeAppsOwnerIdentifier(identifier)));
}

function normalizeAppsOwnerIdentifier(value: string | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function listingConfigString(listing: PublicationListing | undefined, key: string) {
  const value = listing?.config?.[key];
  return typeof value === "string" ? value : "";
}

function listingRuntimeUrl(listing: PublicationListing | undefined, key: "productionUrl") {
  const direct = listingConfigString(listing, key);
  if (direct) {
    return direct;
  }

  const builderRuntime = listing?.config?.builderSnapshot;
  if (isPlainRecord(builderRuntime)) {
    const runtime = builderRuntime.runtime;
    if (isPlainRecord(runtime)) {
      const value = runtime[key];
      return typeof value === "string" ? value : "";
    }
  }

  return "";
}

function codeFromListing(product: AppsProductItem, listing?: PublicationListing) {
  const productionUrl = listingRuntimeUrl(listing, "productionUrl") || readDraftString(reviewDraftFromListing(listing), "launchUrl", "");
  const code = codeFromUrl(productionUrl);
  if (code) {
    return code;
  }

  return listing?.targetId || product.id;
}

function codeFromUrl(value: string) {
  try {
    const hostname = new URL(value).hostname;
    return hostname.endsWith(".example.invalid") ? hostname.replace(".example.invalid", "") : hostname;
  } catch {
    return "";
  }
}

function resourceFriendlyLabel(type: string, t: AppsTFunction) {
  return appsResourceLabel(type, t);
}

function resourceSortWeight(type = "") {
  if (type.includes("pages_project")) {
    return 5;
  }
  if (type.includes("pages_function")) {
    return 6;
  }
  if (type.includes("d1")) {
    return 10;
  }
  if (type.includes("kv")) {
    return 20;
  }
  if (type.includes("r2")) {
    return 30;
  }
  if (type.includes("worker") || type.includes("deploy") || type.includes("static_assets")) {
    return 40;
  }
  if (type.includes("cron")) {
    return 50;
  }
  if (type.includes("queue")) {
    return 60;
  }
  if (type.includes("auth")) {
    return 70;
  }
  if (type.includes("secret")) {
    return 80;
  }
  if (type.includes("migration") || type.includes("schema")) {
    return 90;
  }
  if (type.includes("logs")) {
    return 100;
  }
  if (type.includes("domain")) {
    return 110;
  }
  if (type.includes("mcp")) {
    return 120;
  }

  return 200;
}

function resourceClipboardValue(resource: AppsResource, t: AppsTFunction) {
  return [
    `${resourceFriendlyLabel(resource.type, t)}: ${resource.resourceName}`,
    `type: ${resource.type}`,
    `provider: ${resource.provider}`,
    `environment: ${resource.environment}`,
    `status: ${resource.status}`,
    resource.bindingName ? `binding: ${resource.bindingName}` : "",
    resource.resourceId ? `resourceId: ${resource.resourceId}` : ""
  ].filter(Boolean).join("\n");
}

function domainClipboardValue(domain: AppsDomain, t: AppsTFunction) {
  return [
    `${appsDomainResourceLabel(domain.type, t)}: ${domain.hostname}`,
    `environment: ${domain.environment}`,
    `status: ${domain.status}`,
    domain.fallbackUrl ? `fallbackUrl: ${domain.fallbackUrl}` : "",
    domain.routeStatus ? `routeStatus: ${domain.routeStatus}` : "",
    domain.certificateStatus ? `certificateStatus: ${domain.certificateStatus}` : ""
  ].filter(Boolean).join("\n");
}

function resourceReadyState(status: string): AppsProductProgressState {
  return isProvisionedStatus(status) || status === "placeholder" ? "ready" : "pending";
}

function resourceStatusLabel(status: string, t: AppsTFunction) {
  return appsResourceStatusLabel(status, undefined, t);
}

function formatAppsDetailList(values?: string[]) {
  return values && values.length > 0 ? values.join(", ") : "-";
}

function marketStatusLabel(status: string | undefined, t: AppsTFunction) {
  return appsMarketStatusLabel(status, t);
}

export function marketListingRows(listing: PublicationListing | undefined, t: AppsTFunction): AppsDetailRow[] {
  if (!listing) {
    return [
      { label: t("apps.field.marketStatus"), value: marketStatusLabel(undefined, t) },
      { label: t("apps.field.nextStep"), value: t("apps.field.nextStepSubmitReview"), wide: true }
    ];
  }

  return [
    { label: t("apps.field.marketName"), value: listing.name, wide: true },
    { label: t("apps.field.marketStatus"), value: marketStatusLabel(listing.status, t) },
    { label: t("apps.field.riskLevel"), value: listing.riskLevel ?? "low" },
    { label: t("apps.field.reviewVersion"), value: listing.reviewVersionId || "-" },
    { label: t("apps.field.listedVersion"), value: listing.listedVersionId || "-" },
    { label: t("apps.field.tags"), value: formatAppsDetailList(listing.tags), wide: true },
    { label: t("apps.field.reviewNotes"), value: listing.reviewNotes || "-", wide: true }
  ];
}

function mailDevelopmentResource(app:AppsApp,t:AppsTFunction):AppsDevelopmentResourceItem[] {
  const resources=app.resources.filter(resource=>resource.type==="email_sending"||resource.type==="email_routing");
  if(!resources.length)return [];
  const status=resources.some(resource=>resource.status==="failed")?"failed":resources.every(resource=>resource.status==="ready")?"ready":"pending";
  const address=app.manifest?.email?.routing.address || app.manifest?.email?.sending.senderMailbox || "-";
  return [{copyValue:address+"\n"+t("apps.mail.agentPrompt",{appId:app.id}),detail:address,environment:appsEnvironmentLabel(resources[0].environment,t),label:t("apps.mail.title"),state:resourceReadyState(status),status:resourceStatusLabel(status,t),type:"email_sending"}];
}
