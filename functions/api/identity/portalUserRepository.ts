import { hasUserRolesTable, userProfileColumns } from "./profileSchema.ts";
import { profileDetailsFromRow } from "./profileDetails.ts";
import { normalizeAssignedRoles, normalizeIdentityProvider, normalizeRole, readOptionalString, readString } from "../values.ts";
import type { AuthPrincipal, CurrentUser, IdentityEnv } from "./types.ts";

export async function findUserIdByIdentity(db: D1Database, principal: AuthPrincipal) {
  const row = await db
    .prepare(
      `
      SELECT user_id AS userId
      FROM user_identity_profiles
      WHERE provider = ? AND provider_tenant_id = ? AND provider_subject_id = ?
      LIMIT 1
      `
    )
    .bind(principal.identity.provider, principal.identity.tenantId, principal.identity.objectId)
    .first<{ userId: string }>();

  return row?.userId;
}

export async function findUserIdByEmail(db: D1Database, email: string) {
  const row = await db
    .prepare("SELECT id AS userId FROM users WHERE email = ? LIMIT 1")
    .bind(email)
    .first<{ userId: string }>();

  return row?.userId;
}

export async function insertUserIfMissing<TEnv extends IdentityEnv>(
  db: D1Database,
  userId: string,
  principal: AuthPrincipal,
  env: TEnv
) {
  await db
    .prepare(
      `
      INSERT OR IGNORE INTO users (id, team_id, name, email, role, last_seen_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `
    )
    .bind(
      userId,
      env.DEFAULT_TEAM_ID ?? "team-ai-adoption",
      principal.name,
      principal.email,
      principal.role
    )
    .run();
}

export async function updateLastSeenAt(db: D1Database, userId: string, canonicalEmail?: string) {
  await db
    .prepare(
      `
      UPDATE users
      SET status = CASE WHEN status = 'invited' THEN 'active' ELSE status END,
          email = COALESCE(NULLIF(?, ''), email),
          last_seen_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `
    )
    .bind(canonicalEmail ?? "", userId)
    .run();
}

export async function upsertIdentityProfile(db: D1Database, userId: string, principal: AuthPrincipal) {
  const profileColumns = await userProfileColumns(db);
  const orgColumnNames = [
    profileColumns.departmentId ? "department_id" : "",
    profileColumns.departmentPathJson ? "department_path_json" : ""
  ].filter(Boolean);
  const orgPlaceholders = orgColumnNames.map(() => "?");
  const orgUpdateLines = [
    profileColumns.departmentId ? "department_id = excluded.department_id" : "",
    profileColumns.departmentPathJson ? "department_path_json = excluded.department_path_json" : ""
  ].filter(Boolean);
  const orgValues = [
    ...(profileColumns.departmentId ? [principal.departmentId ?? ""] : []),
    ...(profileColumns.departmentPathJson ? [JSON.stringify(principal.departmentPath ?? [])] : [])
  ];

  await db
    .prepare(
      `
      INSERT INTO user_identity_profiles (
        user_id,
        provider,
        provider_tenant_id,
        provider_subject_id,
        principal_name,
        email,
        display_name,
        department,
        ${orgColumnNames.length > 0 ? `${orgColumnNames.join(",")},` : ""}
        job_title,
        profile_json,
        synced_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${orgPlaceholders.length > 0 ? `${orgPlaceholders.join(",")},` : ""} ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        provider = excluded.provider,
        provider_tenant_id = excluded.provider_tenant_id,
        provider_subject_id = excluded.provider_subject_id,
        principal_name = excluded.principal_name,
        email = excluded.email,
        display_name = excluded.display_name,
        department = excluded.department,
        ${orgUpdateLines.length > 0 ? `${orgUpdateLines.join(",")},` : ""}
        profile_json = CASE
          WHEN user_identity_profiles.profile_json IS NULL
            OR user_identity_profiles.profile_json = ''
            OR user_identity_profiles.profile_json = '{}'
          THEN excluded.profile_json
          ELSE user_identity_profiles.profile_json
        END,
        synced_at = CURRENT_TIMESTAMP
      `
    )
    .bind(
      userId,
      principal.identity.provider,
      principal.identity.tenantId,
      principal.identity.objectId,
      principal.identity.principalName,
      principal.email,
      principal.name,
      principal.department ?? "",
      ...orgValues,
      "",
      JSON.stringify({ source: principal.identity.provider })
    )
    .run();
}

export async function readPortalCurrentUser(db: D1Database, userId: string, fallbackUser: CurrentUser): Promise<CurrentUser | undefined> {
  const userColumns = await userProfileColumns(db);
  const hasUserRoles = await hasUserRolesTable(db);
  const row = await db
    .prepare(
      `
      SELECT
        users.id,
        users.name,
        users.email,
        ${userColumns.avatarUrl ? "COALESCE(users.avatar_url, '')" : "''"} AS avatarUrl,
        users.role,
        ${hasUserRoles ? "COALESCE((SELECT group_concat(user_roles.role) FROM user_roles WHERE user_roles.user_id = users.id), '')" : "''"} AS roles,
        users.status,
        user_identity_profiles.department,
        ${userColumns.departmentId ? "user_identity_profiles.department_id" : "''"} AS departmentId,
        ${userColumns.departmentPathJson ? "user_identity_profiles.department_path_json" : "'[]'"} AS departmentPathJson,
        user_identity_profiles.job_title AS jobTitle,
        user_identity_profiles.profile_json AS profileJson,
        user_identity_profiles.provider,
        user_identity_profiles.provider_tenant_id AS tenantId,
        user_identity_profiles.provider_subject_id AS objectId,
        user_identity_profiles.principal_name AS principalName,
        teams.name AS team
      FROM users
      JOIN teams ON teams.id = users.team_id
      LEFT JOIN user_identity_profiles ON user_identity_profiles.user_id = users.id
      WHERE users.id = ?
      LIMIT 1
      `
    )
    .bind(userId)
    .first<Record<string, unknown>>();

  if (!row) {
    return undefined;
  }
  const details = profileDetailsFromRow(row);

  return {
    defaultAgent: fallbackUser.defaultAgent ?? null,
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    avatarUrl: readOptionalString(row.avatarUrl),
    team: fallbackUser.team,
    ...details,
    ...(fallbackUser.departmentDisplayPath ? { departmentDisplayPath: fallbackUser.departmentDisplayPath } : {}),
    departmentId: details.departmentId ?? fallbackUser.departmentId,
    departmentPath: details.departmentPath ?? fallbackUser.departmentPath,
    role: normalizeRole(row.role),
    roles: normalizeAssignedRoles(row.roles, row.role),
    identity: {
      authenticationMethod: fallbackUser.identity.authenticationMethod,
      provider: normalizeIdentityProvider(row.provider),
      tenantId: readString(row.tenantId) || fallbackUser.identity.tenantId,
      objectId: readString(row.objectId) || fallbackUser.identity.objectId,
      principalName: readString(row.principalName) || fallbackUser.identity.principalName
    }
  };
}
