import type { MarketTranslate } from "./models";
import type { MarketItem } from "./types";

export type PublicationInteractionAction = "app.visit_url" | "skill.add_to_agent" | "skill.download_zip";

export async function copySkillInstallPrompt(item: MarketItem, t: MarketTranslate) {
  const prompt = buildSkillInstallPrompt(item, t);

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(prompt);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = prompt;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.setAttribute("readonly", "true");
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

export async function recordPublicationInstall(item: MarketItem, installType: "bookmark" | "download" | "team" | "user") {
  const listingId = item.listing?.id;

  if (!listingId) {
    return;
  }

  const response = await fetch(`/api/listings/${encodeURIComponent(listingId)}/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      installType,
      version: marketListingVersion(item) || undefined
    })
  });

  if (!response.ok) {
    throw new Error("publication_install_record_failed");
  }
}

export async function recordPublicationInteraction(
  {
    action,
    listingId,
    source,
    targetId,
    version
  }: {
    action: PublicationInteractionAction;
    listingId?: string;
    source: string;
    targetId: string;
    version?: string;
  }
) {
  const response = await fetch("/api/publication/interactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action,
      listingId,
      source,
      targetId,
      version
    }),
    keepalive: action === "app.visit_url"
  });

  if (!response.ok) {
    throw new Error("publication_interaction_record_failed");
  }
}

export function buildSkillInstallPrompt(item: MarketItem, t: MarketTranslate) {
  const listingId = item.listing?.id ?? "";
  const skillId = item.targetId;
  const slugHint = skillSlugHint(item);
  const versionHint = marketListingVersion(item);
  const clientHint = "codex";

  return [
    t("market.agentInstallPrompt.title"),
    "",
    t("market.agentInstallPrompt.infoTitle"),
    t("market.agentInstallPrompt.listingId", { listingId: listingId || t("market.agentInstallPrompt.searchRequired") }),
    t("market.agentInstallPrompt.skillId", { skillId }),
    t("market.agentInstallPrompt.name", { name: item.name }),
    t("market.agentInstallPrompt.slugHint", { slugHint }),
    versionHint ? t("market.agentInstallPrompt.versionHint", { versionHint }) : "",
    "",
    t("market.agentInstallPrompt.stepsTitle"),
    listingId
      ? t("market.agentInstallPrompt.stepDownload", { listingId, client: clientHint })
      : t("market.agentInstallPrompt.stepSearch", { name: item.name }),
    t("market.agentInstallPrompt.stepVerify"),
    t("market.agentInstallPrompt.stepUnzip"),
    t("market.agentInstallPrompt.stepInstall"),
    t("market.agentInstallPrompt.stepCodexPath"),
    t("market.agentInstallPrompt.stepExisting"),
    t("market.agentInstallPrompt.stepReport")
  ].filter(Boolean).join("\n");
}

function skillSlugHint(item: MarketItem) {
  const configSlug = readConfigString(item.listing?.config, "slug");
  if (configSlug) {
    return configSlug;
  }

  return item.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || item.targetId;
}

export function readConfigString(config: Record<string, unknown> | undefined, key: string | string[]) {
  const keys = Array.isArray(key) ? key : [key];

  for (const configKey of keys) {
    const value = config?.[configKey];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

export function marketListingVersion(item: MarketItem) {
  const config = item.listing?.config;
  const reviewDraft = readConfigRecord(config, "reviewDraft");
  const builderSnapshot = readConfigRecord(config, "builderSnapshot");
  const snapshotReviewDraft = readConfigRecord(builderSnapshot, "reviewDraft");

  return readFirstText(
    item.listing?.listedVersionId,
    readConfigString(reviewDraft, "version"),
    readConfigString(snapshotReviewDraft, "version"),
    item.listing?.reviewVersionId,
    item.skill?.version,
    item.app?.version
  );
}

function readConfigRecord(source: Record<string, unknown> | undefined, key: string) {
  const value = source?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readFirstText(...values: Array<string | undefined>) {
  return values.find((value) => value?.trim())?.trim() ?? "";
}
