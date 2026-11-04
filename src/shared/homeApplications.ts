import type { HomeAppDisplay, PublicationListing, PortalApp } from "./types.ts";

export function homeAppPresentation(listing: PublicationListing): { display: HomeAppDisplay } {
  return {
    display: listing.homeDisplay ?? "normal"
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
