import { formatPortalJourneyLevelLabel, portalJourneyLevels } from "../../../../src/shared/journey";
import type { Locale } from "../../../../src/portal/i18n";
import type { PortalJourneyLevelKey } from "../../../../src/shared/types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type OnlineUserProfile = {
  avatarUrl?: string;
  bio?: string;
  department?: string;
  email?: string;
  id: string;
  jobTitle?: string;
  journeyCommunityContributionPoints?: number;
  journeyLevelKey?: PortalJourneyLevelKey;
  journeyTotalPoints?: number;
  name?: string;
  team?: string;
};

export async function loadOnlineUserProfiles(
  userIds: string[],
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<OnlineUserProfile[]> {
  const ids = Array.from(new Set(userIds.map((id) => id.trim()).filter(Boolean))).slice(0, 100);
  if (ids.length === 0) {
    return [];
  }

  const search = new URLSearchParams({ ids: ids.join(",") });
  const response = await fetchImpl(`/api/users/batch?${search.toString()}`, {
    headers: { Accept: "application/json" },
    signal
  });
  const payload = await response.json().catch(() => undefined) as { users?: unknown } | undefined;

  if (!response.ok || !Array.isArray(payload?.users)) {
    throw new Error(`online_user_profiles_failed_${response.status}`);
  }

  return payload.users.flatMap(normalizeOnlineUserProfile);
}

export function onlineUserLevelLabel(levelKey: PortalJourneyLevelKey | undefined, locale: Locale) {
  if (!levelKey) {
    return undefined;
  }

  const level = portalJourneyLevels.find((candidate) => candidate.key === levelKey);
  return level ? formatPortalJourneyLevelLabel(level, locale) : undefined;
}

function normalizeOnlineUserProfile(value: unknown): OnlineUserProfile[] {
  if (!isRecord(value)) {
    return [];
  }

  const id = readOptionalString(value.id);
  if (!id) {
    return [];
  }

  const avatarUrl = readOptionalString(value.avatarUrl);
  const bio = readOptionalString(value.bio);
  const department = readOptionalString(value.department);
  const email = readOptionalString(value.email);
  const journeyLevelKey = readJourneyLevelKey(value.journeyLevelKey);
  const journeyCommunityContributionPoints = readOptionalNumber(value.journeyCommunityContributionPoints);
  const jobTitle = readOptionalString(value.jobTitle);
  const journeyTotalPoints = readOptionalNumber(value.journeyTotalPoints);
  const name = readOptionalString(value.name);
  const team = readOptionalString(value.team);

  return [{
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(bio ? { bio } : {}),
    ...(department ? { department } : {}),
    ...(email ? { email } : {}),
    id,
    ...(jobTitle ? { jobTitle } : {}),
    ...(journeyCommunityContributionPoints !== undefined ? { journeyCommunityContributionPoints } : {}),
    ...(journeyLevelKey ? { journeyLevelKey } : {}),
    ...(journeyTotalPoints !== undefined ? { journeyTotalPoints } : {}),
    ...(name ? { name } : {}),
    ...(team ? { team } : {})
  }];
}

function readJourneyLevelKey(value: unknown): PortalJourneyLevelKey | undefined {
  return value === "newcomer" || value === "explorer" || value === "contributor" || value === "builder" || value === "master"
    ? value
    : undefined;
}

function readOptionalString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function readOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
