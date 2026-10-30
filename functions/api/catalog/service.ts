import { fallbackPortal } from "../../../src/shared/fallbackPortal.ts";
import { portalJourneyLevels } from "../../../src/shared/journey.ts";
import type { PortalCurrentUserStatus, PortalJourneyLevelKey } from "../../../src/shared/types.ts";
import { requireDb } from "../http.ts";
import { CATALOG_FORUM_TOPIC_LIMIT, selectedForumTopicIdsSql } from "./forumProjection.ts";
import { readCategories } from "./readModels.ts";
import { catalogCoverColumns, hasTableColumn, userProfileColumns } from "./schema.ts";
import type { CatalogCoverColumns, CatalogDeps, CatalogEnv, CurrentUser, UserProfileColumns } from "./types.ts";
import { cacheableUserAvatarUrl } from "../users/avatar.ts";

export { CATALOG_FORUM_TOPIC_LIMIT, catalogCoverColumns, hasTableColumn, selectedForumTopicIdsSql, userProfileColumns };
export type { CatalogCoverColumns, UserProfileColumns };

export function createCatalogApi<TEnv extends CatalogEnv>(_deps: CatalogDeps<TEnv>) {
  return {
    loadCatalog(db: D1Database | undefined, currentUser: CurrentUser) {
      return loadCatalog(db, currentUser);
    }
  };
}

export async function loadCatalog(
  db: D1Database | undefined,
  currentUser: CurrentUser
) {
  const catalogDb = requireDb(db);
  const [categories, currentUserSummary] = await Promise.all([
    readCategories(catalogDb),
    readPersistedCurrentUserSummary(catalogDb, currentUser.id)
  ]);
  const currentLevel = portalJourneyLevels.find((level) => level.key === currentUserSummary.journeyLevelKey)
    ?? portalJourneyLevels[0];

  return {
    portal: fallbackPortal.portal,
    currentUser: {
      ...currentUser,
      avatarUrl: cacheableUserAvatarUrl(currentUser.id, currentUser.avatarUrl),
      status: currentUserSummary
    },
    categories,
    hubListings: [],
    publicationListings: [],
    skills: [],
    dataServices: [],
    apps: [],
    discussions: [],
    usage: fallbackPortal.usage,
    mcpTools: [],
    activityEvents: [],
    journey: {
      ...fallbackPortal.journey,
      level: currentLevel,
      updatedAt: currentUserSummary.updatedAt ?? fallbackPortal.journey.updatedAt
    },
    audit: [],
    reviewQueue: []
  };
}

export async function readPersistedCurrentUserSummary(
  db: D1Database,
  userId: string
): Promise<PortalCurrentUserStatus> {
  try {
    const row = await db
      .prepare(
        `
        SELECT
          COALESCE(
            (SELECT current_level_key FROM portal_user_journey_state WHERE user_id = ? LIMIT 1),
            'newcomer'
          ) AS journeyLevelKey,
          EXISTS(
            SELECT 1 FROM portal_user_badges WHERE user_id = ? AND badge_key = 'mcp_connected'
          ) AS mcpConnected,
          EXISTS(
            SELECT 1 FROM portal_user_badges WHERE user_id = ? AND badge_key = 'token_ready'
          ) AS tokenApplied,
          (SELECT updated_at FROM portal_user_journey_state WHERE user_id = ? LIMIT 1) AS updatedAt
        `
      )
      .bind(userId, userId, userId, userId)
      .first<Record<string, unknown>>();

    return {
      journeyLevelKey: readJourneyLevelKey(row?.journeyLevelKey),
      mcpConnected: readBoolean(row?.mcpConnected),
      tokenApplied: readBoolean(row?.tokenApplied),
      ...(readOptionalText(row?.updatedAt) ? { updatedAt: readOptionalText(row?.updatedAt) } : {})
    };
  } catch (error) {
    if (!isMissingJourneySummaryTable(error)) {
      throw error;
    }

    return defaultCurrentUserSummary();
  }
}

function defaultCurrentUserSummary(): PortalCurrentUserStatus {
  return {
    journeyLevelKey: "newcomer",
    mcpConnected: false,
    tokenApplied: false
  };
}

function readJourneyLevelKey(value: unknown): PortalJourneyLevelKey {
  const key = readOptionalText(value);
  return portalJourneyLevels.some((level) => level.key === key)
    ? key as PortalJourneyLevelKey
    : "newcomer";
}

function readBoolean(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function readOptionalText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function isMissingJourneySummaryTable(error: unknown) {
  return error instanceof Error && /no such table[^\n]*portal_user_(journey_state|badges)|portal_user_(journey_state|badges)/i.test(error.message);
}

export function hasCatalogContent(catalog: { apps: unknown[]; dataServices: unknown[]; discussions: unknown[]; hubListings?: unknown[]; publicationListings: unknown[]; skills: unknown[] }) {
  return [catalog.hubListings ?? [], catalog.publicationListings, catalog.skills, catalog.dataServices, catalog.apps, catalog.discussions].some((items) => items.length > 0);
}
