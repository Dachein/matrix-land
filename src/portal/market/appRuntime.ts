import type { PublicationListing, PortalApp } from "../../shared/types";

type MarketAppRuntimeSource = {
  app?: Pick<PortalApp, "launchUrl">;
  listing?: PublicationListing;
  tags?: string[];
};

export function marketAppLaunchUrlFromSource(source: MarketAppRuntimeSource) {
  const { app, listing } = source;
  const config = listing?.config;
  const snapshot = readRecord(config, "builderSnapshot");
  const reviewDraft = firstPopulatedRecord(
    readRecord(config, "reviewDraft"),
    readRecord(snapshot, "reviewDraft")
  );
  const appSnapshot = listingAppSnapshot(listing);
  const manifest = readRecord(appSnapshot, "manifest");
  const runtime = readRecord(manifest, "runtime");
  const configuredUrl = firstString(
    app?.launchUrl,
    readString(config, ["productionUrl", "launchUrl", "appUrl"]),
    readString(reviewDraft, ["productionUrl", "launchUrl", "appUrl"]),
    readString(appSnapshot, ["productionUrl", "launchUrl", "appUrl"]),
    readString(runtime, ["productionUrl", "fallbackProductionUrl"]),
    publishedDeploymentUrl(appSnapshot)
  );

  if (configuredUrl) {
    return configuredUrl;
  }

  return "";
}

function listingAppSnapshot(listing: PublicationListing | undefined) {
  const config = listing?.config;
  const snapshot = readRecord(config, "builderSnapshot");
  const verified = readRecord(snapshot, "appsVerified");
  return firstPopulatedRecord(
    readRecord(verified, "app"),
    readRecord(snapshot, "app"),
    readRecord(config, "app")
  );
}

function publishedDeploymentUrl(appSnapshot: Record<string, unknown>) {
  const deployments = appSnapshot.deployments;
  if (!Array.isArray(deployments)) {
    return "";
  }

  const published = deployments.find((deployment) => (
    deployment && typeof deployment === "object"
      && readString(deployment as Record<string, unknown>, "status").toLowerCase() === "published"
  ));
  return published && typeof published === "object"
    ? readString(published as Record<string, unknown>, "url")
    : "";
}

function firstPopulatedRecord(...records: Record<string, unknown>[]) {
  return records.find((record) => Object.keys(record).length > 0) ?? {};
}

function readRecord(source: Record<string, unknown> | undefined, key: string) {
  const value = source?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(source: Record<string, unknown> | undefined, key: string | string[]) {
  const keys = Array.isArray(key) ? key : [key];
  for (const itemKey of keys) {
    const value = source?.[itemKey];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function firstString(...values: Array<string | undefined>) {
  return values.find((value) => value?.trim())?.trim() ?? "";
}
