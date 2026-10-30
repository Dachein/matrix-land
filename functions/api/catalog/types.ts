import type { IdentityProvider, PortalCatalog, UserRole } from "../../../src/shared/types.ts";

export type CurrentUser = PortalCatalog["currentUser"];

export type CatalogEnv = {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  DB?: D1Database;
  DEFAULT_TEAM_ID?: string;
};

export type CatalogDeps<TEnv extends CatalogEnv> = {
  currentUserTeamId(db: D1Database, currentUser: CurrentUser, env: TEnv): Promise<string>;
  normalizeIdentityProvider(value: unknown): IdentityProvider;
  normalizeRole(value: unknown): UserRole;
};

export type CatalogCoverColumns = {
  appCatalogMetadata: boolean;
  publicationListings: boolean;
  skillCatalogMetadata: boolean;
};

export type { UserProfileColumns } from "../identity/profileSchema.ts";

export const CATALOG_FORUM_TOPIC_LIMIT = 30;
