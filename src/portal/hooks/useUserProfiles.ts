import { useEffect, useMemo, useState } from "react";
import type { PortalCatalog, PortalJourneyLevelKey, UserRole } from "../../shared/types";
import type { ProfileModalUser } from "../components/ProfileModal";
import { invalidateMemoryResources, loadMemoryResource, readMemoryResource } from "../lib/memoryResourceCache.ts";
import { subscribeToUserJourneyProjectionUpdates } from "../lib/userJourneyProjectionEvents.ts";

const USER_PROFILE_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

type CurrentPortalUser = Pick<
  PortalCatalog["currentUser"],
  "avatarUrl" | "bio" | "department" | "departmentId" | "departmentPath" | "departmentDisplayPath" | "email" | "id" | "jobTitle" | "location" | "name" | "role" | "team"
>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function useUserProfiles(userIds: readonly string[], currentUser: CurrentPortalUser) {
  const requestedIdsKey = JSON.stringify(normalizeUserProfileIds(userIds));
  const requestedIds = useMemo(() => JSON.parse(requestedIdsKey) as string[], [requestedIdsKey]);
  const currentUserProfile = useMemo(() => profileFromCurrentUser(currentUser), [
    currentUser.avatarUrl,
    currentUser.bio,
    currentUser.department,
    currentUser.departmentId,
    currentUser.departmentPath,
    currentUser.departmentDisplayPath,
    currentUser.email,
    currentUser.id,
    currentUser.jobTitle,
    currentUser.location,
    currentUser.name,
    currentUser.role,
    currentUser.team
  ]);
  const fallbackProfiles = useMemo(
    () => currentUserFallbackProfiles(requestedIds, currentUserProfile),
    [currentUserProfile, requestedIds]
  );
  const cacheKey = `portal-user-profiles:${currentUser.id}:${requestedIds.join(",")}`;
  const initialProfiles = readMemoryResource<Map<string, ProfileModalUser>>(
    cacheKey,
    USER_PROFILE_CACHE_MAX_AGE_MS
  )?.value;
  const [profiles, setProfiles] = useState<Map<string, ProfileModalUser>>(() => initialProfiles ?? fallbackProfiles);

  useEffect(() => {
    let cancelled = false;
    const cached = readMemoryResource<Map<string, ProfileModalUser>>(cacheKey, USER_PROFILE_CACHE_MAX_AGE_MS);

    setProfiles(cached?.value ?? fallbackProfiles);
    void loadMemoryResource({
      key: cacheKey,
      maxAgeMs: USER_PROFILE_CACHE_MAX_AGE_MS,
      load: () => loadUserProfiles(requestedIds, currentUserProfile)
    })
      .then((nextProfiles) => {
        if (!cancelled) {
          setProfiles(nextProfiles);
        }
      })
      .catch(() => {
        if (!cancelled && !cached) {
          setProfiles(fallbackProfiles);
        }
      });

    return () => { cancelled = true; };
  }, [cacheKey, currentUserProfile, fallbackProfiles, requestedIds]);

  useEffect(() => subscribeToUserJourneyProjectionUpdates((update) => {
    if (!requestedIds.includes(update.id)) {
      return;
    }

    invalidateMemoryResources(`portal-user-profiles:${currentUser.id}:`);
    setProfiles((current) => {
      const profile = current.get(update.id);
      if (!profile) {
        return current;
      }

      const next = new Map(current);
      next.set(update.id, { ...profile, ...update });
      return next;
    });
  }), [currentUser.id, requestedIds]);

  return profiles;
}

export async function loadUserProfiles(
  userIds: readonly string[],
  currentUser: CurrentPortalUser,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<Map<string, ProfileModalUser>> {
  const requestedIds = normalizeUserProfileIds(userIds);
  const currentUserProfile = profileFromCurrentUser(currentUser);
  const fallbackProfiles = currentUserFallbackProfiles(requestedIds, currentUserProfile);

  if (requestedIds.length === 0) {
    return fallbackProfiles;
  }

  try {
    const search = new URLSearchParams({ ids: requestedIds.join(",") });
    const response = await fetchImpl(`/api/users/batch?${search.toString()}`, {
      headers: { Accept: "application/json" },
      signal
    });
    const payload = await response.json().catch(() => undefined) as { users?: unknown } | undefined;

    if (!response.ok || !Array.isArray(payload?.users)) {
      return fallbackProfiles;
    }

    const requestedIdSet = new Set(requestedIds);
    const profiles = new Map(fallbackProfiles);
    payload.users.forEach((value) => {
      const profile = normalizeUserProfile(value, currentUserProfile);
      if (profile && requestedIdSet.has(profile.id)) {
        profiles.set(profile.id, profile);
      }
    });
    return profiles;
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return fallbackProfiles;
  }
}

export function normalizeUserProfileIds(userIds: readonly string[]) {
  return Array.from(new Set(userIds.map((id) => id.trim()).filter(Boolean))).slice(0, 100);
}

function currentUserFallbackProfiles(userIds: readonly string[], currentUser: ProfileModalUser) {
  const profiles = new Map<string, ProfileModalUser>();
  if (userIds.includes(currentUser.id)) {
    profiles.set(currentUser.id, currentUser);
  }
  return profiles;
}

function profileFromCurrentUser(user: CurrentPortalUser): ProfileModalUser {
  return {
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    department: user.department,
    ...(user.departmentId ? { departmentId: user.departmentId } : {}),
    ...(user.departmentPath?.length ? { departmentPath: user.departmentPath } : {}),
    ...(user.departmentDisplayPath ? { departmentDisplayPath: user.departmentDisplayPath } : {}),
    email: user.email,
    id: user.id,
    jobTitle: user.jobTitle,
    location: user.location,
    name: user.name || user.email,
    role: user.role,
    team: ""
  };
}

function normalizeUserProfile(value: unknown, currentUser: ProfileModalUser): ProfileModalUser | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readOptionalString(value.id);
  if (!id) {
    return undefined;
  }

  const fallback = id === currentUser.id ? currentUser : undefined;
  const email = readOptionalString(value.email) || fallback?.email || "";
  const incomingDepartmentPath = readStringList(value.departmentPath);
  const departmentPath = incomingDepartmentPath.length > 0 ? incomingDepartmentPath : fallback?.departmentPath;

  return {
    avatarUrl: readOptionalString(value.avatarUrl) || fallback?.avatarUrl,
    bio: readOptionalString(value.bio) || fallback?.bio,
    department: readOptionalString(value.department) || fallback?.department,
    ...((readOptionalString(value.departmentId) || fallback?.departmentId)
      ? { departmentId: readOptionalString(value.departmentId) || fallback?.departmentId }
      : {}),
    ...(departmentPath?.length ? { departmentPath } : {}),
    ...((readOptionalString(value.departmentDisplayPath) || fallback?.departmentDisplayPath)
      ? { departmentDisplayPath: readOptionalString(value.departmentDisplayPath) || fallback?.departmentDisplayPath }
      : {}),
    email,
    id,
    jobTitle: readOptionalString(value.jobTitle) || fallback?.jobTitle,
    journeyCommunityContributionPoints: readOptionalNumber(value.journeyCommunityContributionPoints)
      ?? fallback?.journeyCommunityContributionPoints,
    journeyLevelKey: readJourneyLevelKey(value.journeyLevelKey),
    journeyTotalPoints: readOptionalNumber(value.journeyTotalPoints) ?? fallback?.journeyTotalPoints,
    location: readOptionalString(value.location) || fallback?.location,
    name: readOptionalString(value.name) || fallback?.name || email || id,
    role: readUserRole(value.role) || fallback?.role || "member",
    team: ""
  };
}

function readJourneyLevelKey(value: unknown): PortalJourneyLevelKey | undefined {
  return value === "newcomer" || value === "explorer" || value === "contributor" || value === "builder" || value === "master"
    ? value
    : undefined;
}

function readUserRole(value: unknown): UserRole | undefined {
  return value === "admin" || value === "member" ? value : undefined;
}

function readOptionalString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
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
