import { deliverUserInvitationSafely } from "../../invitationEmail.ts";
import { type Env, type WorkspaceUser, HttpError } from "../../types.ts";
import { upsertPrimaryMemberships } from "../departments.ts";
import { optionalText, requireDb, requiredText } from "../values.ts";
import { readAuthUserById } from "./reads.ts";
import type { UserSnapshotInput } from "./types.ts";
import { normalizeAuthUser, normalizeUserStatus } from "./values.ts";

// Own employee snapshot and role writes.
export async function upsertAuthUserSnapshot(env: Env, input: UserSnapshotInput): Promise<WorkspaceUser> {
  const db = requireDb(env);
  const user = normalizeAuthUser(input);

  if (!user.id) {
    throw new HttpError(400, "missing_user_id");
  }

  await db
    .prepare(
      `
      INSERT INTO auth_users (
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
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        job_title = excluded.job_title,
        name = excluded.name,
        role = excluded.role,
        status = excluded.status,
        department_id = excluded.department_id,
        department_name = excluded.department_name,
        department_path_json = excluded.department_path_json,
        team_id = excluded.team_id,
        team_name = excluded.team_name,
        team_path_json = excluded.team_path_json,
        provider = COALESCE(excluded.provider, auth_users.provider),
        provider_subject = COALESCE(excluded.provider_subject, auth_users.provider_subject),
        source = excluded.source,
        last_seen_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      `
    )
    .bind(
      user.id,
      user.email ?? "",
      user.jobTitle ?? "",
      user.name ?? "",
      user.role ?? "member",
      normalizeUserStatus(user.status),
      user.departmentId ?? null,
      user.department ?? "",
      JSON.stringify(user.departmentPath ?? []),
      user.teamId ?? null,
      user.team ?? "",
      JSON.stringify(user.teamPath ?? []),
      optionalText(input.provider, 80) ?? null,
      optionalText(input.providerSubject, 180) ?? null,
      optionalText(input.source, 80) ?? "portal"
    )
    .run();

  await upsertPrimaryMemberships(env, user);
  if (user.status === "invited") await deliverUserInvitationSafely(env, user.id);
  return user;
}

export async function updateAuthUserRole(env: Env, userId: string, role: string): Promise<WorkspaceUser> {
  const db = requireDb(env);
  const normalizedUserId = requiredText(userId, "missing_user_id", 180);
  const normalizedRole = role === "admin" || role === "member" ? role : undefined;

  if (!normalizedRole) {
    throw new HttpError(400, "invalid_user_role");
  }

  const existing = await readAuthUserById(env, normalizedUserId);
  if (!existing) {
    throw new HttpError(404, "auth_user_not_found");
  }

  await db
    .prepare(
      `
      UPDATE auth_users
      SET role = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `
    )
    .bind(normalizedRole, normalizedUserId)
    .run();

  return { ...existing, role: normalizedRole };
}
