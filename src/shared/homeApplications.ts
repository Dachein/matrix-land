import type { HomeAppDisplay, PublicationListing, PortalApp } from "./types.ts";

const recommendedNames = [
  ["ByeOA", "Bye!OA"],
  ["Frontier Workspace Cookbook"],
  ["Workspace Academy"],
  ["Workspace Onboarding"],
  ["Workspace Ontology Design"],
  ["香港公寓预定", "香港公寓预订"],
  ["WorkBuddy 申请", "WorkBuddy申请", "Workbuddy 使用申请"]
];

function normalizedName(value: string) {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function homeAppPresentation(listing: PublicationListing): { display: HomeAppDisplay } {
  const recommended = recommendedNames.some((names) => names.some((name) => (
    normalizedName(name) === normalizedName(listing.name)
  )));
  return {
    display: listing.homeDisplay ?? (recommended ? "recommended" : "normal")
  };
}

export function isPublicHomeApp(listing: PublicationListing, app?: PortalApp) {
  // The Hub has already checked consumption access. These fields only group its entries.
  if (listing.visibility === "private" || listing.visibility === "team") return false;
  if (listing.homeScope) return listing.homeScope === "public";
  if (app?.accessMode === "targeted") return false;
  const verification = listing.config?.appsVerification as Record<string, unknown> | undefined;
  if (verification?.appVisibility === "private" || verification?.appVisibility === "team") return false;
  const draft = listing.config?.reviewDraft as Record<string, unknown> | undefined;
  return draft?.accessMode !== "targeted";
}
