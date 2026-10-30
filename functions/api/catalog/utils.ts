import type { PortalJourneyLevelKey } from "../../../src/shared/types.ts";
import { cacheableUserAvatarUrl } from "../users/avatar.ts";

export function profileField(prefix: string, name: string) {
  return prefix ? `${prefix}${name.slice(0, 1).toUpperCase()}${name.slice(1)}` : name;
}

export function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

export function readNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function readJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function readJsonArray(value: unknown) {
  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

export function assetUserProfileFromRow(row: Record<string, unknown>, prefix: string, id: string) {
  if (!id) {
    return undefined;
  }

  const journeyLevelKey = readOptionalJourneyLevelKey(row[profileField(prefix, "journeyLevelKey")]);
  const journeyTotalPoints = readOptionalNumber(row[profileField(prefix, "journeyTotalPoints")]);
  const journeyCommunityContributionPoints = readOptionalNumber(
    row[profileField(prefix, "journeyCommunityContributionPoints")]
  );

  return {
    id,
    name: readString(row[profileField(prefix, "name")]),
    email: readString(row[profileField(prefix, "email")]),
    avatarUrl: cacheableUserAvatarUrl(id, row[profileField(prefix, "avatarUrl")]),
    team: readOptionalString(row[profileField(prefix, "team")]),
    department: readOptionalString(row[profileField(prefix, "department")]),
    jobTitle: readOptionalString(row[profileField(prefix, "jobTitle")]),
    journeyLevelKey,
    journeyTotalPoints,
    journeyCommunityContributionPoints
  };
}

function readOptionalJourneyLevelKey(value: unknown): PortalJourneyLevelKey | undefined {
  const key = readOptionalString(value);
  return key === "newcomer" || key === "explorer" || key === "contributor" || key === "builder" || key === "master"
    ? key
    : undefined;
}

function readOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function splitList(value: unknown) {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }

  return value.split(",").filter(Boolean);
}
