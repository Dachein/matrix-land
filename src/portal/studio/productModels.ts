import type { AppsApp, AppsSkill, PublicationListing, PortalCatalog } from "../../shared/types";
import type { AccessTargetUser } from "../lib/accessTargets";
import type { AppsKindFilter, AppsProductAuthor, AppsProductItem, AppsStatusFilter } from "./types";

type CurrentUser = PortalCatalog["currentUser"];

type AppsAuthoredAsset = {
  collaboratorUserIds?: string[];
  ownerUserId: string;
};

export function isCurrentAppsAssetAuthor(asset: AppsAuthoredAsset, currentUser: CurrentUser) {
  const currentIdentifiers = currentAppsUserIdentifiers(currentUser);
  return [asset.ownerUserId, ...(asset.collaboratorUserIds ?? [])]
    .some((identifier) => currentIdentifiers.has(normalizeUserIdentifier(identifier)));
}

export function appsPublicationByTarget(
  listings: PublicationListing[],
  inventoryTargetIds: Iterable<string>
) {
  const inventoryTargets = new Set(inventoryTargetIds);
  return new Map(listings
    .filter((listing) => listing.targetPlane === "apps" && inventoryTargets.has(listing.targetId))
    .map((listing) => [listing.targetId, listing]));
}

export function buildAppsProductItems({
  apps,
  marketByTarget,
  skills
}: {
  apps: AppsApp[];
  marketByTarget: Map<string, PublicationListing>;
  skills: AppsSkill[];
}): AppsProductItem[] {
  return [
    ...apps.map((app) => appsProductFromApp(app, marketByTarget)),
    ...skills.map((skill) => appsProductFromSkill(skill, marketByTarget))
  ];
}

export function appsProductAuthors(
  product: AppsProductItem,
  currentUser: CurrentUser,
  directoryUsers: AccessTargetUser[] = []
): AppsProductAuthor[] {
  const listingProfiles = (product.marketListing ?? product.listing)?.ownerProfiles ?? [];
  const sourceIdentifiers = product.app
    ? [product.app.ownerUserId, ...(product.app.collaboratorUserIds ?? [])]
    : product.appsSkill
      ? [product.appsSkill.ownerUserId, ...(product.appsSkill.collaboratorUserIds ?? [])]
      : listingProfiles.map((profile) => profile.id || profile.email);
  const currentIdentifiers = currentAppsUserIdentifiers(currentUser);
  const authors = new Map<string, AppsProductAuthor>();

  for (const sourceIdentifier of sourceIdentifiers) {
    const identifier = normalizeUserIdentifier(sourceIdentifier);
    if (!identifier) {
      continue;
    }

    const directoryUser = directoryUsers.find((user) => [user.id, user.email]
      .some((value) => normalizeUserIdentifier(value) === identifier));
    const isCurrentUser = currentIdentifiers.has(identifier)
      || Boolean(directoryUser && [directoryUser.id, directoryUser.email]
        .some((value) => currentIdentifiers.has(normalizeUserIdentifier(value))));
    const listingProfile = listingProfiles.find((profile) => [profile.id, profile.email]
      .some((value) => normalizeUserIdentifier(value) === identifier));
    const canonicalId = normalizeUserIdentifier(
      directoryUser?.id
      || (isCurrentUser ? currentUser.id : "")
      || listingProfile?.id
      || sourceIdentifier
    );

    if (!authors.has(canonicalId)) {
      authors.set(canonicalId, {
        avatarUrl: isCurrentUser
          ? currentUser.avatarUrl
          : directoryUser?.avatarUrl || listingProfile?.avatarUrl,
        id: canonicalId,
        name: isCurrentUser
          ? currentUser.name || currentUser.email
          : directoryUser?.name || listingProfile?.name || fallbackAuthorName(sourceIdentifier)
      });
    }
  }

  return [...authors.values()];
}

export function filterAppsProductItems(products: AppsProductItem[], {
  kindFilter,
  query,
  statusFilter
}: {
  kindFilter: AppsKindFilter;
  query: string;
  statusFilter: AppsStatusFilter;
}) {
  const normalizedQuery = query.trim().toLowerCase();

  return products.filter((product) => {
    if (kindFilter === "apps" && product.type !== "app") {
      return false;
    }

    if (kindFilter === "skills" && product.type !== "skill") {
      return false;
    }

    if (statusFilter !== "all" && product.status !== statusFilter && product.marketListing?.status !== statusFilter) {
      return false;
    }

    if (!normalizedQuery) {
      return true;
    }

    return `${product.name} ${product.kind} ${product.owner} ${product.subtitle}`.toLowerCase().includes(normalizedQuery);
  });
}

export function updateAppsProductWithApp(current: AppsProductItem, app: AppsApp, marketByTarget: Map<string, PublicationListing>) {
  if (!current.app || current.app.id !== app.id) {
    return current;
  }

  const listing = marketByTarget.get(app.id);

  return {
    ...current,
    app,
    coverImageUrl: listing?.coverImageUrl ?? current.coverImageUrl,
    name: app.name,
    status: app.status,
    subtitle: app.description,
    updatedAt: app.updatedAt,
    marketListing: listing
  };
}

export function updateAppsProductWithSkill(current: AppsProductItem, skill: AppsSkill, marketByTarget: Map<string, PublicationListing>) {
  if (!current.appsSkill || current.appsSkill.id !== skill.id) {
    return current;
  }

  const listing = marketByTarget.get(skill.id);

  return {
    ...current,
    coverImageUrl: listing?.coverImageUrl ?? current.coverImageUrl,
    kind: "APPS Skill",
    appsSkill: skill,
    name: skill.name,
    status: skill.status,
    subtitle: skill.description,
    updatedAt: skill.updatedAt,
    marketListing: listing
  };
}

function appsProductFromApp(app: AppsApp, marketByTarget: Map<string, PublicationListing>): AppsProductItem {
  const listing = marketByTarget.get(app.id);

  return {
    app,
    coverImageUrl: listing?.coverImageUrl,
    id: `app:${app.id}`,
    type: "app",
    kind: "APPS App",
    name: app.name,
    owner: app.ownerTeamId || app.ownerUserId,
    status: app.status,
    subtitle: app.description,
    updatedAt: app.updatedAt,
    marketListing: listing
  };
}

function appsProductFromSkill(skill: AppsSkill, marketByTarget: Map<string, PublicationListing>): AppsProductItem {
  const listing = marketByTarget.get(skill.id);

  return {
    coverImageUrl: listing?.coverImageUrl,
    appsSkill: skill,
    id: `skill:${skill.id}`,
    type: "skill",
    kind: "APPS Skill",
    name: skill.name,
    owner: skill.ownerUserId,
    status: skill.status,
    subtitle: skill.description,
    updatedAt: skill.updatedAt,
    marketListing: listing
  };
}

function normalizeUserIdentifier(value: string | undefined) {
  return (value ?? "")
    .trim()
    .toLowerCase();
}

function currentAppsUserIdentifiers(currentUser: CurrentUser) {
  return new Set([
    currentUser.id,
    currentUser.email,
    currentUser.identity?.objectId,
    currentUser.identity?.principalName
  ].map(normalizeUserIdentifier).filter(Boolean));
}

function fallbackAuthorName(value: string | undefined) {
  const identifier = String(value ?? "").trim();
  const localPart = identifier.includes("@") ? identifier.split("@")[0] : identifier;
  const words = localPart.split(/[._\-\s]+/).filter(Boolean);
  if (words.length === 0) {
    return identifier || "APPS author";
  }
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
}
