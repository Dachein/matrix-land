import type { Discussion } from "../../shared/types";
import { marketListingVersion, readConfigString } from "./actions";
import { marketAppLaunchUrlFromSource } from "./appRuntime";
import { marketPrimaryMetricCount, marketPublisher, marketSummary } from "./models";
import type { MarketItem } from "./types";
import type { MarketTranslate } from "./models";

export function discussionHref(item: MarketItem, options?: { compose?: boolean }) {
  const params = new URLSearchParams({
    linkedId: item.targetId,
    linkedType: item.kind,
    q: item.name
  });

  if (options?.compose) {
    params.set("compose", "1");
    params.set("category", item.category);
    params.set("description", marketSummary(item));
    if (item.coverImageUrl && !item.coverImageUrl.trim().toLowerCase().startsWith("data:")) {
      params.set("iconUrl", item.coverImageUrl);
    }
    params.set("installs", String(marketPrimaryMetricCount(item)));
    params.set("owner", marketPublisher(item).name);
  }

  return `#/community?${params.toString()}`;
}

export function marketTopicHref(discussion: Discussion) {
  return `#/community/${encodeURIComponent(discussion.id)}`;
}

export function marketArtifactHref(item: MarketItem) {
  if (item.listing?.id) {
    return `/api/listings/${encodeURIComponent(item.listing.id)}/download?source=publication_detail`;
  }

  return item.listing?.artifactUrl ?? "";
}

export function marketAppLaunchUrl(item: MarketItem) {
  return item.kind === "app"
    ? marketAppLaunchUrlFromSource({ app: item.app, listing: item.listing, tags: item.tags })
    : "";
}

export function relatedMarketDiscussions(item: MarketItem, discussions: Discussion[]) {
  const targetName = item.name.trim().toLowerCase();
  const targetId = item.targetId.trim().toLowerCase();
  const linkedKey: "linkedApp" | "linkedSkill" = item.kind === "app" ? "linkedApp" : "linkedSkill";

  return discussions
    .filter((discussion) => {
      const linkedValue = discussion[linkedKey]?.trim().toLowerCase();
      const pluginMatch = discussion.contentPlugins?.some((plugin) => (
        plugin.targetType === item.kind && plugin.targetId === item.targetId
      ));
      const textMatch = [discussion.title, discussion.excerpt, discussion.body, ...(discussion.tags ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return Boolean(
        pluginMatch ||
        linkedValue === targetName ||
        linkedValue === targetId ||
        textMatch.includes(targetName) ||
        textMatch.includes(targetId)
      );
    })
    .sort((left, right) => new Date(right.lastActive).getTime() - new Date(left.lastActive).getTime());
}

export function marketOverviewMarkdown(item: MarketItem, t: MarketTranslate, locale: string) {
  const configuredMarkdown = readMarketConfigString(item, [
    "overviewMarkdown",
    "overviewMd",
    "overview",
    "descriptionMarkdown",
    "descriptionMd",
    "readmeMarkdown",
    "markdown"
  ]);

  if (configuredMarkdown) {
    return configuredMarkdown;
  }

  const lines = [
    `# ${item.name}`,
    "",
    item.description
  ];

  const scopes = item.app?.scopes ?? item.skill?.scopes ?? [];
  if (scopes.length > 0) {
    lines.push("", `## ${t("market.section.scopesDependencies")}`, "", scopes.map((scope) => `- ${scope}`).join("\n"));
  }

  const dependencies = item.skill?.dependencies ?? [];
  if (dependencies.length > 0) {
    lines.push("", `## ${t("market.section.runtime")}`, "", dependencies.map((dependency) => `- ${dependency}`).join("\n"));
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function marketSafetyMarkdown(item: MarketItem, t: MarketTranslate) {
  const reviewDraft = readReviewDraft(item);
  const riskLevel = readFirstString(
    readStringFromRecord(reviewDraft, "riskLevel"),
    item.listing?.riskLevel,
    item.app?.riskLevel,
    item.skill?.riskLevel
  );
  const riskReason = readFirstString(
    readStringFromRecord(reviewDraft, ["riskReason", "securityNotes", "safetyNotes"]),
    item.listing?.reviewNotes,
    item.app?.riskReason,
    item.skill?.reviewNotes
  );
  const permissionNotes = readFirstString(
    readStringFromRecord(reviewDraft, ["permissionNotes", "dataScopeNotes"]),
    item.app?.permissionNotes
  );
  const outputNotes = readFirstString(readStringFromRecord(reviewDraft, "outputNotes"), item.app?.outputNotes);
  const installNotes = readStringFromRecord(reviewDraft, "installNotes");
  const sensitiveDataTypes = readStringListFromRecord(reviewDraft, "sensitiveDataTypes");
  const scopes = item.app?.scopes ?? item.skill?.scopes ?? [];

  const lines = [
    `# ${t("market.safety.title")}`,
    "",
    `- ${t("market.safety.riskLevel")}: ${riskLabel(riskLevel, t)}`,
    riskReason ? `- ${t("market.safety.riskReason")}: ${riskReason}` : "",
    permissionNotes ? `- ${t("market.safety.permissionNotes")}: ${permissionNotes}` : "",
    sensitiveDataTypes.length > 0 ? `- ${t("market.safety.dataTypes")}: ${sensitiveDataTypes.join(", ")}` : "",
    scopes.length > 0 ? `- ${t("market.safety.scopes")}: ${scopes.join(", ")}` : "",
    outputNotes ? `- ${t("market.safety.outputNotes")}: ${outputNotes}` : "",
    installNotes ? `- ${t("market.safety.installNotes")}: ${installNotes}` : ""
  ].filter(Boolean);

  if (lines.length <= 3) {
    lines.push("", t("market.safety.empty"));
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function marketVersionMetadataRows(item: MarketItem, t: MarketTranslate) {
  const reviewDraft = readReviewDraft(item);
  const snapshot = readConfigRecord(item.listing?.config, "builderSnapshot");
  const currentVersion = marketListingVersion(item);
  const reviewVersion = readFirstString(item.listing?.reviewVersionId);
  const changelog = readFirstString(readStringFromRecord(reviewDraft, "changelog"), item.app?.changelog);
  const snapshotVersions = readVersionList(snapshot);

  return [
    currentVersion ? { label: t("market.currentVersion"), value: formatVersion(currentVersion) } : undefined,
    reviewVersion ? { label: t("market.reviewVersion"), value: formatVersion(reviewVersion) } : undefined,
    changelog ? { label: t("market.changelog"), value: changelog } : undefined,
    snapshotVersions.length > 0 ? { label: t("market.versionHistory"), value: snapshotVersions.map(formatVersion).join(" / ") } : undefined
  ].filter((row): row is { label: string; value: string } => Boolean(row));
}

function readMarketConfigString(item: MarketItem, keys: string | string[]) {
  const config = item.listing?.config;
  const rootValue = readConfigString(config, keys);
  if (rootValue) {
    return rootValue;
  }

  const reviewDraft = readReviewDraft(item);
  const draftValue = readStringFromRecord(reviewDraft, keys);
  if (draftValue) {
    return draftValue;
  }

  const snapshot = readConfigRecord(config, "builderSnapshot");
  const snapshotReviewDraft = readConfigRecord(snapshot, "reviewDraft");
  return readStringFromRecord(snapshotReviewDraft, keys);
}

function readReviewDraft(item: MarketItem) {
  const config = item.listing?.config;
  const reviewDraft = readConfigRecord(config, "reviewDraft");
  if (Object.keys(reviewDraft).length > 0) {
    return reviewDraft;
  }

  const snapshot = readConfigRecord(config, "builderSnapshot");
  return readConfigRecord(snapshot, "reviewDraft");
}

function readConfigRecord(source: Record<string, unknown> | undefined, key: string) {
  const value = source?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readStringFromRecord(source: Record<string, unknown>, key: string | string[]) {
  const keys = Array.isArray(key) ? key : [key];

  for (const itemKey of keys) {
    const value = source[itemKey];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function readStringListFromRecord(source: Record<string, unknown>, key: string) {
  const value = source[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  return typeof value === "string"
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

function readVersionList(source: Record<string, unknown>) {
  const value = source.versions;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item && typeof item === "object" && "version" in item) {
        const version = (item as { version?: unknown }).version;
        return typeof version === "string" ? version : "";
      }

      return "";
    })
    .filter(Boolean)
    .slice(0, 5);
}

function readFirstString(...values: Array<string | undefined>) {
  return values.find((value) => value?.trim())?.trim() ?? "";
}

function formatVersion(value: string) {
  return value.startsWith("v") ? value : `v${value}`;
}

function riskLabel(value: string, t: MarketTranslate) {
  if (value === "high") {
    return t("market.safety.riskHigh");
  }

  if (value === "medium") {
    return t("market.safety.riskMedium");
  }

  return t("market.safety.riskLow");
}
