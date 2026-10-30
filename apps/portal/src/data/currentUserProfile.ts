import type { ProfileModalUser, ProfileUpdateInput } from "../../../../src/portal/components/ProfileModal";
import type { PortalCatalog } from "../../../../src/shared/types";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function saveCurrentUserProfile(
  currentUser: PortalCatalog["currentUser"],
  updates: ProfileUpdateInput,
  fetcher: Fetcher = fetch
): Promise<PortalCatalog["currentUser"]> {
  let response: Response;

  try {
    response = await fetcher(`/api/users/${encodeURIComponent(currentUser.id)}/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(updates)
    });
  } catch {
    throw new Error("profile_update_failed");
  }

  if (!response.ok) {
    throw new Error("profile_update_failed");
  }

  const payload: unknown = await response.json().catch(() => undefined);
  const savedUser = readSavedProfileUser(payload, currentUser.id);
  if (!savedUser) {
    throw new Error("profile_update_failed");
  }

  return {
    ...currentUser,
    ...savedUser,
    jobTitle: savedUser.jobTitle ?? updates.jobTitle,
    location: savedUser.location ?? updates.location,
    identity: currentUser.identity
  };
}

function readSavedProfileUser(payload: unknown, expectedUserId: string): ProfileModalUser | undefined {
  if (!isRecord(payload) || !isRecord(payload.user)) {
    return undefined;
  }

  const user = payload.user;
  if (
    user.id !== expectedUserId
    || !isNonEmptyString(user.name)
    || !isNonEmptyString(user.email)
    || !isOptionalString(user.team)
    || !isNonEmptyString(user.avatarUrl)
    || !isNonEmptyString(user.bio)
    || (user.role !== "admin" && user.role !== "member")
    || !isOptionalString(user.department)
    || !isOptionalString(user.jobTitle)
    || !isOptionalString(user.location)
  ) {
    return undefined;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    team: "",
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    role: user.role,
    ...(user.department !== undefined ? { department: user.department } : {}),
    ...(user.jobTitle !== undefined ? { jobTitle: user.jobTitle } : {}),
    ...(user.location !== undefined ? { location: user.location } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}
