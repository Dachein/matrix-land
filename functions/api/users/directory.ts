import { hasTableColumn } from "../catalog/schema.ts";
import { cacheableUserAvatarUrl } from "./avatar.ts";

type UserDirectoryPurpose = "access" | "directory" | "mention";

export type UserDirectoryEntry = {
  avatarUrl?: string;
  department?: string;
  departmentId?: string;
  departmentPath?: string[];
  email: string;
  emailPrefix: string;
  id: string;
  name?: string;
  status?: string;
  team?: string;
};

type UserDirectoryEnv = {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  DB?: D1Database;
};

type UserDirectoryContext<TEnv extends UserDirectoryEnv> = EventContext<TEnv, string, unknown>;

type UserDirectoryDeps<TEnv extends UserDirectoryEnv> = {
  httpError(status: number, message: string): Error;
  requireDb(db: D1Database | undefined): D1Database;
  resolveCurrentUser(context: UserDirectoryContext<TEnv>): Promise<unknown>;
};

type UserDirectoryOptions = {
  limit?: number;
  purpose?: UserDirectoryPurpose;
  q?: string;
  statuses?: string[];
};

const AUTH_WORKER_DIRECTORY_TIMEOUT_MS = 8000;

export function createUserDirectoryApi<TEnv extends UserDirectoryEnv>(deps: UserDirectoryDeps<TEnv>) {
  return {
    async listUserDirectory(context: UserDirectoryContext<TEnv>, defaults: UserDirectoryOptions = {}) {
      await deps.resolveCurrentUser(context);
      const url = new URL(context.request.url);
      const purpose = normalizePurpose(url.searchParams.get("purpose") ?? defaults.purpose);
      const statuses = normalizeStatuses(readStatusParams(url.searchParams), defaults.statuses, purpose);
      const q = readQuery(url.searchParams.get("q") ?? defaults.q);
      const limit = readLimit(url.searchParams.get("limit") ?? defaults.limit, purpose);

      const users = await loadUserDirectoryUsers(context.env, { limit, q, statuses });

      if (users) {
        return users.slice(0, limit);
      }

      // Keep the forum usable during an Auth directory outage. This fallback
      // can only know about active Portal members; invited users remain
      // available whenever the canonical Auth directory is reachable.
      if (purpose === "mention") {
        return loadPortalMentionUsers(deps.requireDb(context.env.DB), { limit, q });
      }

      throw deps.httpError(503, "auth_users_unavailable");
    }
  };
}

export async function loadPortalMentionUsers(
  db: D1Database,
  input: Pick<UserDirectoryOptions, "limit" | "q"> = {}
) {
  const hasAvatarUrl = await hasTableColumn(db, "users", "avatar_url");
  const query = readQuery(input.q);
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 1000);
  const queryPattern = `%${query}%`;
  const rows = await db
    .prepare(
      `
      SELECT
        users.id,
        users.name,
        users.email,
        ${hasAvatarUrl ? "COALESCE(users.avatar_url, '')" : "''"} AS avatarUrl,
        teams.name AS team,
        user_identity_profiles.department
      FROM users
      JOIN teams ON teams.id = users.team_id
      LEFT JOIN user_identity_profiles ON user_identity_profiles.user_id = users.id
      WHERE users.status = 'active'
        ${query ? "AND (LOWER(users.name) LIKE ? OR LOWER(users.email) LIKE ?)" : ""}
      ORDER BY LOWER(COALESCE(NULLIF(users.name, ''), users.email)), LOWER(users.email)
      LIMIT ?
      `
    )
    .bind(...(query ? [queryPattern, queryPattern] : []), limit)
    .all<Record<string, unknown>>();

  return sortDirectoryUsers((rows.results ?? []).flatMap((row): UserDirectoryEntry[] => {
    const id = readString(row.id).trim();
    const email = readString(row.email).trim();

    if (!id || !email) {
      return [];
    }

    const avatarUrl = cacheableUserAvatarUrl(row.id, row.avatarUrl);
    return [{
      ...(avatarUrl ? { avatarUrl } : {}),
      department: readOptionalString(row.department),
      email,
      emailPrefix: emailPrefix(email),
      id,
      name: readOptionalString(row.name) ?? email,
      team: ""
    }];
  }), query);
}

export async function loadUserDirectoryUsers<TEnv extends UserDirectoryEnv>(
  env: TEnv,
  input: Pick<UserDirectoryOptions, "limit" | "q" | "statuses"> = {}
): Promise<UserDirectoryEntry[] | undefined> {
  const baseUrl = env.AUTH_WORKER_URL?.trim().replace(/\/+$/, "");
  const serviceToken = env.AUTH_SERVICE_TOKEN?.trim();

  if (!baseUrl || !serviceToken) {
    return undefined;
  }

  const url = new URL(`${baseUrl}/v1/admin/users`);
  const statuses = normalizeStatuses([], input.statuses, "directory");
  const allowedStatuses = new Set(statuses);
  statuses.forEach((status) => url.searchParams.append("status", status));
  const query = readQuery(input.q);

  if (query) {
    url.searchParams.set("q", query);
  }

  url.searchParams.set("limit", String(Math.min(Math.max(input.limit ?? 1000, 1), 1000)));

  let response: Response;

  try {
    response = await fetchWithTimeout(url.toString(), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${serviceToken}`
      }
    }, AUTH_WORKER_DIRECTORY_TIMEOUT_MS);
  } catch {
    return undefined;
  }

  if (!response.ok) {
    return undefined;
  }

  const payload = await response.json() as Record<string, unknown>;
  const users = Array.isArray(payload.users) ? payload.users : [];

  return sortDirectoryUsers(users.flatMap((user): UserDirectoryEntry[] => {
    if (!user || typeof user !== "object" || Array.isArray(user)) {
      return [];
    }

    const entry = directoryEntryFromAuthUser(user as Record<string, unknown>);
    if (!entry.id || !entry.email) {
      return [];
    }

    // Auth currently returns status on every row. Keep compatibility with an
    // older Auth response that omitted it, while rejecting any explicit status
    // outside the caller's active/invited policy.
    if (entry.status && !allowedStatuses.has(entry.status)) {
      return [];
    }

    return [entry];
  }), query);
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

export async function filterDirectoryUsersToPortalUsers(db: D1Database, users: UserDirectoryEntry[]) {
  const ids = Array.from(new Set(users.map((user) => user.id).filter(Boolean)));

  if (ids.length === 0) {
    return [];
  }

  const hasAvatarUrl = await hasTableColumn(db, "users", "avatar_url");
  const rows = await db
    .prepare(
      `
      SELECT
        users.id,
        users.name,
        users.email,
        ${hasAvatarUrl ? "COALESCE(users.avatar_url, '')" : "''"} AS avatarUrl,
        teams.name AS team,
        user_identity_profiles.department
      FROM users
      JOIN teams ON teams.id = users.team_id
      LEFT JOIN user_identity_profiles ON user_identity_profiles.user_id = users.id
      WHERE users.status = 'active'
        AND users.id IN (${ids.map(() => "?").join(", ")})
      `
    )
    .bind(...ids)
    .all<Record<string, unknown>>();
  const portalById = new Map((rows.results ?? []).map((row) => [readString(row.id), row]));

  return users.flatMap((user) => {
    const portalUser = portalById.get(user.id);

    if (!portalUser) {
      return [];
    }

    const email = readString(portalUser.email) || user.email;
    const avatarUrl = cacheableUserAvatarUrl(portalUser.id, portalUser.avatarUrl) ?? user.avatarUrl;
    return [{
      ...user,
      ...(avatarUrl ? { avatarUrl } : {}),
      email,
      emailPrefix: emailPrefix(email),
      name: readOptionalString(portalUser.name) ?? user.name,
      team: "",
      department: readOptionalString(portalUser.department) ?? user.department
    }];
  });
}

function directoryEntryFromAuthUser(user: Record<string, unknown>): UserDirectoryEntry {
  const email = readString(user.email);
  const avatarUrl = readOptionalString(user.avatarUrl);

  return {
    id: readString(user.id),
    name: readOptionalString(user.name) ?? email,
    ...(avatarUrl ? { avatarUrl } : {}),
    email,
    emailPrefix: emailPrefix(email),
    status: readOptionalString(user.status)?.toLowerCase(),
    team: "",
    department: readOptionalString(user.department),
    departmentId: readOptionalString(user.departmentId),
    departmentPath: readStringList(user.departmentPath)
  };
}

function normalizePurpose(value: unknown): UserDirectoryPurpose {
  return value === "access" || value === "mention" || value === "directory" ? value : "directory";
}

function normalizeStatuses(rawValues: string[], defaultValues: string[] | undefined, purpose: UserDirectoryPurpose) {
  const statuses = [...rawValues, ...(defaultValues ?? [])]
    .flatMap((value) => readString(value).split(","))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value === "active" || value === "invited");

  if (statuses.length > 0) {
    return Array.from(new Set(statuses));
  }

  return ["active", "invited"];
}

function readStatusParams(params: URLSearchParams) {
  return [...params.getAll("status"), ...params.getAll("statuses")];
}

function readLimit(value: unknown, purpose: UserDirectoryPurpose) {
  const fallback = purpose === "mention" ? 8 : 1000;
  const parsed = Number(value ?? fallback);

  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 1), 1000) : fallback;
}

function readQuery(value: unknown) {
  return readString(value).trim().toLowerCase().slice(0, 80);
}

function sortDirectoryUsers(users: UserDirectoryEntry[], query: string) {
  if (!query) {
    return users;
  }

  return [...users].sort((left, right) => directoryRank(left, query) - directoryRank(right, query) || left.email.localeCompare(right.email));
}

function directoryRank(user: UserDirectoryEntry, query: string) {
  if (user.emailPrefix.toLowerCase() === query) {
    return 0;
  }
  if (user.emailPrefix.toLowerCase().startsWith(query)) {
    return 1;
  }
  if (user.email.toLowerCase().startsWith(query)) {
    return 2;
  }
  if ((user.name ?? "").toLowerCase().includes(query)) {
    return 3;
  }

  return 4;
}

function emailPrefix(email: string) {
  return email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
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
