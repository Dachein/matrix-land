import { type Env, type WorkspaceUser, HttpError } from "../../types.ts";
import { jsonStringList, normalizeEmail, optionalText, requireDb } from "../values.ts";
import type { AuthUserListRow, AuthUserRow, ListAuthUsersInput } from "./types.ts";
import { emailLocalPart, normalizeUserStatusList } from "./values.ts";

// Employee lookup, list and persistence-to-identity representation.
export async function readEmailOtpAuthUser(env: Env, email: string): Promise<WorkspaceUser | undefined> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return undefined;
  }

  const user = await readAuthUserByEmail(env, normalizedEmail);
  return isLoginEligibleAuthUser(user) ? user : undefined;
}

export async function listAuthUsers(env: Env, input: ListAuthUsersInput = {}) {
  const db = requireDb(env);
  const statuses = normalizeUserStatusList(input.statuses);
  const filters: string[] = [];
  const binds: unknown[] = [];
  const query = optionalText(input.q, 160);

  if (statuses.length > 0) {
    filters.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    binds.push(...statuses);
  }

  if (query) {
    filters.push("(lower(email) LIKE lower(?) OR lower(name) LIKE lower(?) OR lower(department_name) LIKE lower(?))");
    binds.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }

  const departmentId = optionalText(input.departmentId, 180);
  if (departmentId) {
    if (input.includeDescendants !== false) {
      filters.push("(department_id = ? OR EXISTS (SELECT 1 FROM json_each(department_path_json) WHERE value = ?))");
      binds.push(departmentId, departmentId);
    } else {
      filters.push("department_id = ?");
      binds.push(departmentId);
    }
  }

  const rows = await db
    .prepare(
      `
      SELECT
        id,
        email,
        job_title,
        name,
        role,
        status,
        department_id,
        department_name,
        department_path_json,
        team_id,
        team_name,
        team_path_json,
        provider,
        provider_subject,
        source,
        first_seen_at,
        last_seen_at,
        first_seen_at AS created_at,
        updated_at
      FROM auth_users
      ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END,
        lower(department_name),
        lower(name),
        lower(email)
      LIMIT ?
      `
    )
    .bind(...binds, Math.min(Math.max(input.limit ?? 500, 1), 1000))
    .all<AuthUserListRow>();

  return (rows.results ?? []).map(authUserListItemFromRow);
}

export async function readAuthUserSnapshot(env: Env, user: WorkspaceUser) {
  const filters: string[] = [];
  const binds: unknown[] = [];

  if (user.id) {
    filters.push("id = ?");
    binds.push(user.id);
  }

  if (user.email) {
    filters.push("lower(email) = lower(?)");
    binds.push(user.email);
  }

  if (filters.length === 0 || !env.AUTH_DB) {
    return undefined;
  }

  const row = await env.AUTH_DB
    .prepare(
      `
      SELECT
        id,
        email,
        job_title,
        name,
        role,
        status,
        department_id,
        department_name,
        department_path_json,
        team_id,
        team_name,
        team_path_json,
        provider,
        provider_subject,
        source
      FROM auth_users
      WHERE ${filters.join(" OR ")}
      ORDER BY id = ? DESC
      LIMIT 1
      `
    )
    .bind(...binds, user.id)
    .first<AuthUserRow>();

  return row ? authUserFromRow(row) : undefined;
}

export async function readAuthUserByProvider(env: Env, provider: string | undefined, providerSubject: string | undefined) {
  if (!env.AUTH_DB || !provider || !providerSubject) {
    return undefined;
  }

  const row = await env.AUTH_DB
    .prepare(
      `
      SELECT
        id,
        email,
        job_title,
        name,
        role,
        status,
        department_id,
        department_name,
        department_path_json,
        team_id,
        team_name,
        team_path_json,
        provider,
        provider_subject,
        source
      FROM auth_users
      WHERE provider = ?
        AND provider_subject = ?
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END,
        updated_at DESC
      LIMIT 1
      `
    )
    .bind(provider, providerSubject)
    .first<AuthUserRow>();

  return row ? authUserFromRow(row) : undefined;
}

export async function readAuthUserByEmail(env: Env, email: string) {
  if (!env.AUTH_DB) {
    throw new HttpError(503, "auth_db_not_configured");
  }

  const row = await env.AUTH_DB
    .prepare(
      `
      SELECT
        id,
        email,
        job_title,
        name,
        role,
        status,
        department_id,
        department_name,
        department_path_json,
        team_id,
        team_name,
        team_path_json,
        provider,
        provider_subject,
        source
      FROM auth_users
      WHERE lower(email) = lower(?)
      LIMIT 1
      `
    )
    .bind(email)
    .first<AuthUserRow>();

  return row ? authUserFromRow(row) : undefined;
}

export async function readAuthUserById(env: Env, userId: string | undefined) {
  const id = optionalText(userId, 180);

  if (!env.AUTH_DB || !id) {
    return undefined;
  }

  const row = await env.AUTH_DB
    .prepare(
      `
      SELECT
        id,
        email,
        job_title,
        name,
        role,
        status,
        department_id,
        department_name,
        department_path_json,
        team_id,
        team_name,
        team_path_json,
        provider,
        provider_subject,
        source
      FROM auth_users
      WHERE id = ?
      LIMIT 1
      `
    )
    .bind(id)
    .first<AuthUserRow>();

  return row ? authUserFromRow(row) : undefined;
}

export async function readConfirmedLoginAuthUser(env: Env, userId: string, loginEmail: string | undefined) {
  const user = await readAuthUserById(env, userId);

  if (!user || !isLoginEligibleAuthUser(user)) {
    throw new HttpError(409, "invalid_login_confirmation_user");
  }

  const matches = normalizeEmail(user.email) === normalizeEmail(loginEmail);
  if (!matches) {
    throw new HttpError(409, "login_confirmation_email_mismatch");
  }

  return user;
}

export function isLoginEligibleAuthUser(user: WorkspaceUser | undefined) {
  return user?.status === "active" || user?.status === "invited";
}

function authUserFromRow(row: AuthUserRow): WorkspaceUser {
  return {
    department: row.department_name || undefined,
    departmentId: row.department_id ?? undefined,
    departmentPath: jsonStringList(row.department_path_json),
    email: row.email || undefined,
    id: row.id,
    identityProvider: row.provider ?? undefined,
    jobTitle: row.job_title || undefined,
    name: row.name || undefined,
    role: row.role || undefined,
    providerSubject: row.provider_subject ?? undefined,
    source: row.source || undefined,
    status: row.status || undefined,
    team: row.team_name || undefined,
    teamId: row.team_id ?? undefined,
    teamPath: jsonStringList(row.team_path_json)
  };
}

function authUserListItemFromRow(row: AuthUserListRow) {
  return {
    ...authUserFromRow(row),
    createdAt: row.first_seen_at || row.created_at || undefined,
    identityProvider: row.provider ?? undefined,
    lastSeenAt: row.last_seen_at || undefined,
    principalName: row.email || undefined,
    providerSubject: row.provider_subject ?? undefined,
    source: row.source || undefined,
    updatedAt: row.updated_at || undefined
  };
}
