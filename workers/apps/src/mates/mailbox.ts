import type { Env, Principal } from "../core/types.ts";

/** Private mailbox identity, independent of permission to invoke a public Mate. */
export async function readDefaultMailbox(env: Env, lookup: { address: string } | { principal: Principal }) {
  const byAddress = "address" in lookup;
  const row = await env.APPS_DB.prepare(`
    SELECT id AS mateId, org_id AS orgId, owner_user_id AS userId, work_email AS address, display_name AS name
    FROM apps_mates
    WHERE is_default = 1 AND status = 'published' AND active_release_id IS NOT NULL
      AND ${byAddress ? "lower(work_email) = ?" : "org_id = ? AND owner_user_id = ?"}
    LIMIT 1
  `).bind(...(byAddress ? [lookup.address.trim().toLowerCase()] : [lookup.principal.orgId, lookup.principal.sub]))
    .first<{ mateId: string; orgId: string; userId: string; address: string; name: string }>();
  return { mailbox: row || null };
}
