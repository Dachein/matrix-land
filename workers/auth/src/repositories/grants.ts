import type { Env } from "../types.ts";
import { normalizeGrantStatus, optionalText, requireDb, requiredText } from "./values.ts";

// Own app grant persistence.
type GrantInput = {
  appId?: string;
  approvedByUserId?: string;
  expiresAt?: string;
  id?: string;
  reason?: string;
  requestedByUserId?: string;
  status?: string;
  userId?: string;
};

export async function readGrantStatus(env: Env, appId: string, userId: string) {
  if (!env.AUTH_DB) {
    return undefined;
  }

  const row = await env.AUTH_DB
    .prepare(
      `
      SELECT status
      FROM auth_grants
      WHERE app_id = ?
        AND user_id = ?
        AND grant_type = 'app_access'
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
      LIMIT 1
      `
    )
    .bind(appId, userId)
    .first<{ status: "approved" | "pending" | "rejected" | "revoked" }>();

  return row?.status;
}

export async function upsertGrant(env: Env, input: GrantInput) {
  const db = requireDb(env);
  const grant = {
    id: optionalText(input.id, 160) ?? `grant-${crypto.randomUUID()}`,
    appId: requiredText(input.appId, "missing_app_id", 160),
    userId: requiredText(input.userId, "missing_user_id", 160),
    status: normalizeGrantStatus(input.status),
    requestedByUserId: optionalText(input.requestedByUserId, 160),
    approvedByUserId: optionalText(input.approvedByUserId, 160),
    reason: optionalText(input.reason, 1000) ?? "",
    expiresAt: optionalText(input.expiresAt, 80)
  };

  await db
    .prepare(
      `
      INSERT INTO auth_grants (
        id,
        app_id,
        user_id,
        grant_type,
        status,
        requested_by_user_id,
        approved_by_user_id,
        reason,
        expires_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, 'app_access', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(app_id, user_id, grant_type) DO UPDATE SET
        status = excluded.status,
        approved_by_user_id = excluded.approved_by_user_id,
        reason = excluded.reason,
        expires_at = excluded.expires_at,
        updated_at = CURRENT_TIMESTAMP
      `
    )
    .bind(
      grant.id,
      grant.appId,
      grant.userId,
      grant.status,
      grant.requestedByUserId ?? null,
      grant.approvedByUserId ?? null,
      grant.reason,
      grant.expiresAt ?? null
    )
    .run();

  return grant;
}

export async function updateGrantStatus(env: Env, id: string, input: GrantInput) {
  const db = requireDb(env);
  const status = normalizeGrantStatus(input.status);
  const approvedByUserId = optionalText(input.approvedByUserId, 160);
  const reason = optionalText(input.reason, 1000) ?? "";
  const expiresAt = optionalText(input.expiresAt, 80);

  await db
    .prepare(
      `
      UPDATE auth_grants
      SET status = ?,
          approved_by_user_id = COALESCE(?, approved_by_user_id),
          reason = COALESCE(NULLIF(?, ''), reason),
          expires_at = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `
    )
    .bind(status, approvedByUserId ?? null, reason, expiresAt ?? null, id)
    .run();

  return { id, status, approvedByUserId, reason, expiresAt };
}
