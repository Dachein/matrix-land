import type { PublicationListing, PortalApp, Skill } from "../../shared/types";
import type { MarketCategoryKey } from "../../shared/marketCategories";

export type MarketKind = "app" | "skill";
export type MarketFilter = "all" | "app" | "skill";
export type MarketCategoryFilter = "all" | MarketCategoryKey;
export type MarketView = "card" | "list";

export type MarketItem = {
  id: string;
  targetId: string;
  kind: MarketKind;
  name: string;
  owner: string;
  status: "pending_review" | "listed" | "delisted" | "deleted";
  description: string;
  summary: string;
  coverImageUrl?: string;
  category: string;
  tags: string[];
  installs: number;
  agentAddCount: number;
  downloadCount: number;
  visitCount: number;
  comments: number;
  rating: number;
  likeCount: number;
  likedByCurrentUser: boolean;
  updatedAt: string;
  app?: PortalApp;
  listing?: PublicationListing;
  skill?: Skill;
};

export type MarketTypeCounts = {
  all: number;
  app: number;
  skill: number;
};
