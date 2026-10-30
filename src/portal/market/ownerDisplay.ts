import type { AssetPublisherProfile, PublicationListing, PortalApp } from "../../shared/types";

export function portalAppOwnerName(app: PortalApp) {
  return app.publisherProfile?.name || app.publisherProfile?.email || "Frontier Workspace";
}

export function publicationOwnerProfiles(listing: PublicationListing | undefined): AssetPublisherProfile[] {
  const seenIdentifiers = new Set<string>();

  return (listing?.ownerProfiles ?? []).filter((profile) => {
    const identifiers = [profile.id, profile.email]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    if (identifiers.some((identifier) => seenIdentifiers.has(identifier))) {
      return false;
    }

    identifiers.forEach((identifier) => seenIdentifiers.add(identifier));
    return true;
  });
}

export function publicationOwnerNames(listing: PublicationListing) {
  return publicationOwnerProfiles(listing)
    .map((profile) => profile.name || profile.email || profile.id)
    .map((name) => name.trim())
    .filter(Boolean);
}

export function publicationOwnerLabel(listing: PublicationListing | undefined, fallback: string) {
  const alias = listing?.ownerAliasName?.trim();
  if (alias) {
    return alias;
  }

  const names = listing ? publicationOwnerNames(listing) : [];
  return names.length > 0 ? names.join(" · ") : fallback;
}
