import type { AdminUserProfile, IdentityProvider, UserRole } from "../../../src/shared/types.ts";
import { normalizeAssignedRoles } from "../values.ts";
import type { UserProfileColumns } from "../catalog/types.ts";
import { loadAdminUsers } from "./service.ts";
import { HttpError } from "../http.ts";

type AdminUsersEnv = {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  DB?: D1Database;
};

type AdminUsersContext<TEnv extends AdminUsersEnv> = EventContext<TEnv, string, unknown>;

type AdminUsersDeps<TEnv extends AdminUsersEnv> = {
  normalizeIdentityProvider(value: unknown): IdentityProvider;
  normalizeRole(value: unknown): UserRole;
  requireAdminPortalUser(context: AdminUsersContext<TEnv>): Promise<unknown>;
  requireDb(db: D1Database | undefined): D1Database;
  userProfileColumns(db: D1Database): Promise<UserProfileColumns>;
};

const AUTH_WORKER_ADMIN_USERS_TIMEOUT_MS = 8000;

export function createAdminUsersApi<TEnv extends AdminUsersEnv>(deps: AdminUsersDeps<TEnv>) {
  return {
    async listAdminUsers(context: AdminUsersContext<TEnv>) {
      await deps.requireAdminPortalUser(context);
      const db = deps.requireDb(context.env.DB);
      const userColumns = await deps.userProfileColumns(db);

      return loadMergedAdminUsers(db, userColumns, context.env, deps);
    }
  };
}

export async function loadMergedAdminUsers<TEnv extends AdminUsersEnv>(
  db: D1Database,
  userColumns: UserProfileColumns,
  env: TEnv,
  deps: Pick<AdminUsersDeps<TEnv>, "normalizeIdentityProvider" | "normalizeRole">
) {
  const [portalUsers, authUsers] = await Promise.all([
    loadAdminUsers(db, userColumns, deps),
    loadAuthWorkerAdminUsers(env, deps).catch(() => undefined)
  ]);

  // A configured identity directory owns the full inventory, including invitees
  // who have never visited Portal. Its failure must not silently shrink the list.
  if (env.AUTH_WORKER_URL?.trim() && !authUsers) {
    throw new HttpError(503, "admin_users_source_unavailable");
  }

  return mergeAdminUsers(authUsers, portalUsers);
}

export function mergeAdminUsers(authUsers: AdminUserProfile[] | undefined, portalUsers: AdminUserProfile[]) {
  if (!authUsers) {
    return portalUsers;
  }

  const portalById = new Map<string, AdminUserProfile>();

  for (const user of portalUsers) {
    const idKey = normalizedText(user.id);

    if (idKey && !portalById.has(idKey)) {
      portalById.set(idKey, user);
    }
  }

  return authUsers.map((authUser) => {
    const portalUser = portalById.get(normalizedText(authUser.id));
    return portalUser ? mergeAdminUser(authUser, portalUser) : authUser;
  });
}

export async function loadAuthWorkerAdminUsers<TEnv extends AdminUsersEnv>(
  env: TEnv,
  deps: Pick<AdminUsersDeps<TEnv>, "normalizeIdentityProvider" | "normalizeRole">
) {
  const baseUrl = env.AUTH_WORKER_URL?.trim().replace(/\/+$/, "");
  const serviceToken = env.AUTH_SERVICE_TOKEN?.trim();

  if (!baseUrl || !serviceToken) {
    return undefined;
  }

  const url = new URL(`${baseUrl}/v1/admin/users`);
  url.searchParams.append("status", "active");
  url.searchParams.append("status", "invited");
  url.searchParams.set("limit", "1000");

  let response: Response;

  try {
    response = await fetchWithTimeout(url.toString(), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${serviceToken}`
      }
    }, AUTH_WORKER_ADMIN_USERS_TIMEOUT_MS);
  } catch {
    return undefined;
  }

  if (!response.ok) {
    return undefined;
  }

  const payload = await response.json() as Record<string, unknown>;
  const users = Array.isArray(payload.users) ? payload.users : [];

  return users
    .filter((user): user is Record<string, unknown> => Boolean(user && typeof user === "object" && !Array.isArray(user)))
    .map((user) => ({
      id: readString(user.id),
      name: readString(user.name) || readString(user.email),
      email: readString(user.email),
      avatarUrl: undefined,
      team: "",
      department: readOptionalString(user.department),
      departmentId: readOptionalString(user.departmentId),
      departmentPath: readStringList(user.departmentPath),
      jobTitle: readOptionalString(user.jobTitle),
      journeyLevelKey: "newcomer" as const,
      journeyTotalPoints: 0,
      journeyBadgeCount: 0,
      role: deps.normalizeRole(user.role),
      roles: normalizeAssignedRoles(user.roles, user.role),
      status: readString(user.status) || "active",
      lastSeenAt: readOptionalString(user.lastSeenAt),
      createdAt: readOptionalString(user.createdAt),
      identityProvider: deps.normalizeIdentityProvider(user.identityProvider),
      principalName: readOptionalString(user.principalName)
    }))
    .filter((user) => user.id && user.email);
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function mergeAdminUser(authUser: AdminUserProfile, portalUser: AdminUserProfile): AdminUserProfile {
  const roles = normalizeAssignedRoles([...(authUser.roles ?? []), ...(portalUser.roles ?? [])],
    authUser.role === "admin" || portalUser.role === "admin" ? "admin" : "member");
  return {
    ...portalUser,
    ...authUser,
    id: textOr(authUser.id, portalUser.id) ?? "",
    name: textOr(authUser.name, portalUser.name, authUser.email, portalUser.email) ?? "",
    email: textOr(authUser.email, portalUser.email) ?? "",
    avatarUrl: textOr(portalUser.avatarUrl, authUser.avatarUrl),
    team: "",
    department: textOr(authUser.department, portalUser.department),
    departmentId: textOr(authUser.departmentId, portalUser.departmentId),
    departmentPath: listOr(authUser.departmentPath, portalUser.departmentPath),
    jobTitle: textOr(authUser.jobTitle, portalUser.jobTitle),
    journeyLevelKey: portalUser.journeyLevelKey ?? authUser.journeyLevelKey,
    journeyTotalPoints: portalUser.journeyTotalPoints ?? authUser.journeyTotalPoints,
    journeyBadgeCount: portalUser.journeyBadgeCount ?? authUser.journeyBadgeCount,
    bio: textOr(portalUser.bio, authUser.bio),
    location: textOr(portalUser.location, authUser.location),
    role: authUser.role === "admin" || portalUser.role === "admin" ? "admin" : authUser.role,
    roles,
    status: textOr(authUser.status, portalUser.status) ?? "active",
    lastSeenAt: laterTimestamp(authUser.lastSeenAt, portalUser.lastSeenAt),
    createdAt: earlierTimestamp(authUser.createdAt, portalUser.createdAt),
    identityProvider: authUser.identityProvider ?? portalUser.identityProvider,
    principalName: textOr(authUser.principalName, portalUser.principalName)
  };
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

function readStringList(value: unknown) {
  return Array.isArray(value) ? value.map(readString).filter(Boolean) : [];
}

function normalizedText(value: unknown) {
  return readString(value).trim().toLowerCase();
}

function textOr(...values: Array<string | undefined>) {
  for (const value of values) {
    const text = readString(value).trim();
    if (text) {
      return text;
    }
  }

  return undefined;
}

function listOr(...values: Array<string[] | undefined>) {
  return values.find((value) => Array.isArray(value) && value.length > 0);
}

function laterTimestamp(left: string | undefined, right: string | undefined) {
  const leftMs = timestampMs(left);
  const rightMs = timestampMs(right);

  if (!leftMs && !rightMs) {
    return textOr(left, right);
  }

  return leftMs >= rightMs ? left : right;
}

function earlierTimestamp(left: string | undefined, right: string | undefined) {
  const leftMs = timestampMs(left);
  const rightMs = timestampMs(right);

  if (!leftMs && !rightMs) {
    return textOr(left, right);
  }
  if (!leftMs) {
    return right;
  }
  if (!rightMs) {
    return left;
  }

  return leftMs <= rightMs ? left : right;
}

function timestampMs(value: string | undefined) {
  const timestamp = Date.parse(readString(value));
  return Number.isFinite(timestamp) ? timestamp : 0;
}
