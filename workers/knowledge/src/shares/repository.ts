import { HttpError } from "../http.ts";
import { isKnowledgeServiceHandbookObject } from "../objects/access.ts";
import type { Env, ShareRow } from "../types.ts";
import { validateShareSlug } from "./values.ts";

export async function activePublicShareForObject(env: Env, objectId: string) {
  return env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT *
      FROM knowledge_shares
      WHERE object_id = ?
        AND visibility = 'public'
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
      ORDER BY created_at DESC
      LIMIT 1
      `
    )
    .bind(objectId)
    .first<ShareRow>();
}

export async function requirePublicShare(env: Env, slug: string) {
  const normalizedSlug = validateShareSlug(slug);
  const share = await env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT *
      FROM knowledge_shares
      WHERE slug = ?
        AND visibility = 'public'
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
      LIMIT 1
      `
    )
    .bind(normalizedSlug)
    .first<ShareRow>();
  if (!share) {
    throw new HttpError(404, "knowledge_public_share_not_found");
  }
  // A handbook may have been shared before its folder was upgraded. Never
  // expose Agent instructions through a legacy or racing public-link row.
  if (await isKnowledgeServiceHandbookObject(env, share.object_id)) {
    throw new HttpError(404, "knowledge_public_share_not_found");
  }
  return share;
}

export async function countActivePublicSharesForObject(env: Env, objectId: string) {
  const row = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT COUNT(*) AS count
       FROM knowledge_shares
       WHERE object_id = ? AND visibility = 'public' AND revoked_at IS NULL`
    )
    .bind(objectId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}
