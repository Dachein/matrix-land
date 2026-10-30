import type { PortalCatalog } from "../../shared/types";
import { normalizeMarketCategoryKey, normalizeMarketCategoryName } from "../../shared/marketCategories";
import type { useI18n } from "../i18n";
import type { MarketCategoryFilter, MarketFilter, MarketItem, MarketKind, MarketTypeCounts } from "./types";
import { publicationOwnerLabel, publicationOwnerNames } from "./ownerDisplay";

export type MarketTranslate = ReturnType<typeof useI18n>["t"];

// Hub membership comes exclusively from the server-authorized discovery
// projection. Apps and Skills only enrich those rows with presentation data.
export function buildMarketItems(catalog: PortalCatalog): MarketItem[] {
  const apps = new Map(catalog.apps.map((app) => [app.id, app]));
  const skills = new Map(catalog.skills.map((skill) => [skill.id, skill]));
  const items = catalog.hubListings
    .filter((listing) => listing.status === "listed")
    .map((listing): MarketItem => {
      const isPortalTarget = listing.targetPlane !== "apps";
      const app = isPortalTarget && listing.type === "app" ? apps.get(listing.targetId) : undefined;
      const skill = isPortalTarget && listing.type === "skill" ? skills.get(listing.targetId) : undefined;

      return {
        id: `${listing.targetPlane ?? "portal"}:${listing.type}:${listing.targetId}`,
        targetId: listing.targetId,
        kind: listing.type,
        name: listing.name,
        owner: publicationOwnerLabel(listing, "Frontier Workspace"),
        status: listing.status,
        description: listing.description,
        summary: listing.summary || listing.description,
        coverImageUrl: listing.coverImageUrl,
        category: normalizeMarketCategoryName(listing.category, listing.type === "app" ? "workflow" : "research"),
        tags: [...listing.tags],
        installs: listing.installs,
        agentAddCount: listing.agentAddCount ?? 0,
        downloadCount: listing.downloadCount ?? (listing.type === "skill" ? listing.installs : 0),
        visitCount: listing.visitCount ?? 0,
        comments: listing.comments,
        rating: listing.rating,
        likeCount: listing.likeCount ?? 0,
        likedByCurrentUser: listing.likedByCurrentUser ?? false,
        updatedAt: listing.updatedAt,
        app,
        skill,
        listing
      };
    });

  return items.sort((left, right) => (
    marketPrimaryMetricCount(right) - marketPrimaryMetricCount(left)
    || left.name.localeCompare(right.name)
  ));
}

export function visibleMarketItems(items: MarketItem[], filter: MarketFilter, categoryFilter: MarketCategoryFilter, query: string) {
  const normalizedQuery = query.trim().toLowerCase();

  return items.filter((item) => {
    const searchable = [
      item.name,
      item.owner,
      ...(item.listing ? publicationOwnerNames(item.listing) : []),
      item.category,
      normalizeMarketCategoryKey(item.category),
      item.skill?.kind,
      item.description,
      item.summary,
      item.kind
    ].join(" ").toLowerCase();

    return (
      item.status === "listed" &&
      (filter === "all" || item.kind === filter) &&
      (categoryFilter === "all" || normalizeMarketCategoryKey(item.category) === categoryFilter) &&
      (!normalizedQuery || searchable.includes(normalizedQuery))
    );
  });
}

export function countMarketItems(items: MarketItem[]): MarketTypeCounts {
  const listed = items.filter((item) => item.status === "listed");

  return {
    all: listed.length,
    app: listed.filter((item) => item.kind === "app").length,
    skill: listed.filter((item) => item.kind === "skill").length
  };
}

export function marketSummary(item: MarketItem) {
  return item.summary || item.description;
}

export function marketLikeCount(item: MarketItem) {
  return item.likeCount;
}

export function marketPrimaryMetricCount(item: MarketItem) {
  return item.kind === "app"
    ? item.visitCount
    : item.agentAddCount + item.downloadCount;
}

export function marketPublisher(item: MarketItem) {
  if (item.listing?.ownerProfiles?.length) {
    return {
      avatarUrl: item.listing.ownerProfiles?.[0]?.avatarUrl,
      name: item.owner
    };
  }

  return { name: item.owner };
}

export function typeLabel(kind: MarketKind, t: MarketTranslate) {
  if (kind === "app") {
    return t("market.apps");
  }

  return t("market.skills");
}

export function marketSkillKindLabel(item: MarketItem, t: MarketTranslate) {
  if (item.kind !== "skill") {
    return "";
  }

  if (item.skill?.kind === "knowledge") {
    return t("ui.kind.knowledge");
  }

  if (item.skill?.kind === "app") {
    return t("ui.kind.app");
  }

  return "";
}
