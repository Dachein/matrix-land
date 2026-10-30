import type { AdminUserProfile, AssignedUserRole, PortalCatalog, UserRole } from "../../../shared/types";
import type { Locale } from "../../i18n";
import type { Translate } from "../types";

export function adminUserJourneyLevel(user: AdminUserProfile, catalog: PortalCatalog) {
  const fallbackKey = user.id === catalog.currentUser.id ? catalog.journey.level.key : "newcomer";
  const levelKey = user.journeyLevelKey ?? fallbackKey;
  return catalog.journey.levels.find((level) => level.key === levelKey)
    ?? catalog.journey.levels[0]
    ?? catalog.journey.level;
}

export function adminJourneyLevelLabel(level: PortalCatalog["journey"]["level"], locale: Locale) {
  const name = locale === "zh-CN" ? level.nameZh : level.nameEn;
  return `Level ${level.rank} · ${name}`;
}

export function adminJourneyLevelTitle(user: AdminUserProfile, catalog: PortalCatalog, level: PortalCatalog["journey"]["level"], locale: Locale, t: Translate) {
  const points = user.id === catalog.currentUser.id && user.journeyTotalPoints === undefined
    ? catalog.journey.totalPoints
    : user.journeyTotalPoints ?? 0;
  const badges = user.id === catalog.currentUser.id && user.journeyBadgeCount === undefined
    ? catalog.journey.badgeCount
    : user.journeyBadgeCount ?? 0;
  const label = adminJourneyLevelLabel(level, locale);

  return t("admin.users.levelTitle", { badges, label, points });
}

export function userSummary(users: AdminUserProfile[], nowMs = Date.now()) {
  const total = users.length;
  const activated = users.filter((user) => normalizedUserStatus(user.status) === "active").length;
  const admins = users.filter((user) => assignedUserRoles(user).includes("admin")).length;
  const recent = users.filter((user) => isRecentLogin(user.lastSeenAt, nowMs)).length;
  const completeProfiles = users.filter((user) => user.avatarUrl && user.name && user.bio).length;

  return {
    total,
    activated,
    admins,
    recent,
    profileCompletion: total > 0 ? Math.round((completeProfiles / total) * 100) : 0
  };
}

export function userInitials(value: string) {
  const parts = value.trim().split(/[\s.@_-]+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [parts[0] ?? ""];

  return letters.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

export function roleLabel(role: UserRole, t: Translate) {
  return role === "admin" ? t("admin.users.roleAdmin") : t("admin.users.roleMember");
}

export function assignedUserRoles(user: Pick<AdminUserProfile, "role" | "roles">): AssignedUserRole[] {
  const roles = new Set(user.roles ?? []);
  if (user.role === "admin") roles.add("admin");
  return ["admin", "community_admin"].filter((role): role is AssignedUserRole => roles.has(role as AssignedUserRole));
}

export function assignedRoleLabel(role: AssignedUserRole, t: Translate) {
  return role === "community_admin" ? t("admin.users.roleCommunityAdmin") : t("admin.users.roleAdmin");
}

export function userStatusLabel(status: string | undefined, t: Translate) {
  const normalizedStatus = normalizedUserStatus(status);

  if (normalizedStatus === "active") {
    return t("admin.status.active");
  }

  if (normalizedStatus === "invited") {
    return t("admin.status.invited");
  }

  return status?.trim() || t("admin.status.limited");
}

export function formatExactTime(value: string | undefined, locale: Locale, t: Translate) {
  const timestamp = timestampMs(value);

  if (!timestamp) {
    return t("common.notRecorded");
  }

  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit"
  }).format(new Date(timestamp));
}

export function formatRelativeTime(value: string | undefined, locale: Locale, t: Translate) {
  const timestamp = timestampMs(value);

  if (!timestamp) {
    return t("admin.users.neverSignedIn");
  }

  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  if (absSeconds < 60) {
    return formatter.format(diffSeconds, "second");
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, "hour");
  }

  const diffDays = Math.round(diffHours / 24);
  if (Math.abs(diffDays) < 30) {
    return formatter.format(diffDays, "day");
  }

  const diffMonths = Math.round(diffDays / 30);
  if (Math.abs(diffMonths) < 12) {
    return formatter.format(diffMonths, "month");
  }

  return formatter.format(Math.round(diffMonths / 12), "year");
}

function isRecentLogin(value: string | undefined, nowMs: number) {
  const timestamp = timestampMs(value);
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const elapsed = nowMs - timestamp;

  return timestamp > 0 && elapsed >= 0 && elapsed < sevenDays;
}

function normalizedUserStatus(value?: string) {
  return value?.trim().toLowerCase() ?? "";
}

function timestampMs(value?: string) {
  if (!value) {
    return 0;
  }

  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const timestamp = new Date(normalized).getTime();

  return Number.isFinite(timestamp) ? timestamp : 0;
}
