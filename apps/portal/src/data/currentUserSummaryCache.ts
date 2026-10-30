import { portalJourneyLevels } from "../../../../src/shared/journey";
import type {
  PortalCatalog,
  PortalCurrentUserStatus,
  PortalJourneyLevelKey
} from "../../../../src/shared/types";

const CURRENT_USER_SUMMARY_CACHE_PREFIX = "workspace-ai:current-user-summary:v1:";

type SummaryCacheEntry = {
  cachedAt: number;
  summary: PortalCurrentUserStatus;
  userId: string;
};

type SummaryStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function hydratePortalCatalogCurrentUserSummary(
  catalog: PortalCatalog,
  storage: SummaryStorage | undefined = browserStorage()
) {
  const serverSummary = currentUserSummaryFromCatalog(catalog);
  const cached = readCachedCurrentUserSummary(catalog.currentUser.id, storage);
  const summary = cached && isCachedSummaryNewer(cached.summary, serverSummary)
    ? cached.summary
    : serverSummary;
  const hydrated = mergePortalCurrentUserSummary(catalog, summary);

  writeCachedCurrentUserSummary(catalog.currentUser.id, summary, storage);
  return hydrated;
}

export function currentUserSummaryFromCatalog(catalog: PortalCatalog): PortalCurrentUserStatus {
  const provided = normalizeCurrentUserSummary(catalog.currentUser.status);
  if (provided) {
    return provided;
  }

  return currentUserSummaryFromJourney(catalog.journey);
}

export function currentUserSummaryFromJourney(
  journey: PortalCatalog["journey"]
): PortalCurrentUserStatus {
  const badgeKeys = new Set((Array.isArray(journey.badges) ? journey.badges : []).map((badge) => badge.badgeKey));
  const journeyLevelKey = isJourneyLevelKey(journey.level?.key)
    ? journey.level.key
    : "newcomer";
  return {
    journeyLevelKey,
    mcpConnected: badgeKeys.has("mcp_connected"),
    tokenApplied: badgeKeys.has("token_ready"),
    ...(typeof journey.updatedAt === "string" && journey.updatedAt ? { updatedAt: journey.updatedAt } : {})
  };
}

export function mergePortalCurrentUserSummary(
  catalog: PortalCatalog,
  value: PortalCurrentUserStatus,
  storage: SummaryStorage | undefined = browserStorage()
) {
  const summary = normalizeCurrentUserSummary(value) ?? currentUserSummaryFromCatalog(catalog);
  const level = portalJourneyLevels.find((candidate) => candidate.key === summary.journeyLevelKey)
    ?? portalJourneyLevels[0];
  const current = normalizeCurrentUserSummary(catalog.currentUser.status);
  const summaryChanged = !sameCurrentUserSummary(current, summary);
  const levelChanged = catalog.journey.level.key !== level.key;

  if (!summaryChanged && !levelChanged) {
    writeCachedCurrentUserSummary(catalog.currentUser.id, summary, storage);
    return catalog;
  }

  const next = {
    ...catalog,
    currentUser: summaryChanged
      ? { ...catalog.currentUser, status: summary }
      : catalog.currentUser,
    journey: levelChanged
      ? { ...catalog.journey, level }
      : catalog.journey
  };
  writeCachedCurrentUserSummary(catalog.currentUser.id, summary, storage);
  return next;
}

export function readCachedCurrentUserSummary(
  userId: string,
  storage: SummaryStorage | undefined = browserStorage()
): SummaryCacheEntry | undefined {
  if (!userId || !storage) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(storage.getItem(summaryCacheKey(userId)) ?? "null") as Partial<SummaryCacheEntry> | null;
    const summary = normalizeCurrentUserSummary(parsed?.summary);
    if (parsed?.userId !== userId || !Number.isFinite(parsed.cachedAt) || !summary) {
      storage.removeItem(summaryCacheKey(userId));
      return undefined;
    }

    return { cachedAt: Number(parsed.cachedAt), summary, userId };
  } catch {
    storage.removeItem(summaryCacheKey(userId));
    return undefined;
  }
}

export function writeCachedCurrentUserSummary(
  userId: string,
  value: PortalCurrentUserStatus,
  storage: SummaryStorage | undefined = browserStorage(),
  cachedAt = Date.now()
) {
  const summary = normalizeCurrentUserSummary(value);
  if (!userId || !storage || !summary) {
    return;
  }

  try {
    storage.setItem(summaryCacheKey(userId), JSON.stringify({ cachedAt, summary, userId }));
  } catch {
    // The server snapshot remains authoritative when browser storage is unavailable.
  }
}

function normalizeCurrentUserSummary(value: unknown): PortalCurrentUserStatus | undefined {
  if (!isRecord(value) || !isJourneyLevelKey(value.journeyLevelKey)) {
    return undefined;
  }

  return {
    journeyLevelKey: value.journeyLevelKey,
    mcpConnected: value.mcpConnected === true,
    tokenApplied: value.tokenApplied === true,
    ...(typeof value.updatedAt === "string" && value.updatedAt.trim()
      ? { updatedAt: value.updatedAt.trim() }
      : {})
  };
}

function sameCurrentUserSummary(
  left: PortalCurrentUserStatus | undefined,
  right: PortalCurrentUserStatus
) {
  return Boolean(left)
    && left?.journeyLevelKey === right.journeyLevelKey
    && left.mcpConnected === right.mcpConnected
    && left.tokenApplied === right.tokenApplied
    && left.updatedAt === right.updatedAt;
}

function summaryUpdatedAt(summary: PortalCurrentUserStatus) {
  const parsed = Date.parse(summary.updatedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function isCachedSummaryNewer(
  cached: PortalCurrentUserStatus,
  server: PortalCurrentUserStatus
) {
  const cachedUpdatedAt = summaryUpdatedAt(cached);
  const serverUpdatedAt = summaryUpdatedAt(server);

  if (cachedUpdatedAt && serverUpdatedAt) {
    return cachedUpdatedAt > serverUpdatedAt;
  }

  if (cachedUpdatedAt) {
    return true;
  }

  return serverUpdatedAt === 0;
}

function summaryCacheKey(userId: string) {
  return `${CURRENT_USER_SUMMARY_CACHE_PREFIX}${userId}`;
}

function browserStorage(): SummaryStorage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function isJourneyLevelKey(value: unknown): value is PortalJourneyLevelKey {
  return portalJourneyLevels.some((level) => level.key === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
