import { platformBrandFromEnv, publicHttpsUrl } from "../../../src/shared/platformBrand.ts";
import { isEmailAllowedByPolicy, readAuthEmailPolicy } from "../../../src/shared/authEmailPolicy.ts";
import { renderInvitationEmail } from "./invitationTemplate.ts";
import type { Env } from "./types.ts";

export async function queueUserInvitation(env: Env, userId: string) {
  await env.AUTH_DB.prepare(`
    INSERT OR IGNORE INTO auth_user_invitation_emails(user_id)
    SELECT id FROM auth_users WHERE id=? AND status='invited' AND trim(email)<>''
  `).bind(userId).run();
}

// The persistent claim prevents parallel syncs and backfills from sending twice.
// Ambiguous provider failures are held for review, rather than automatically resent.
export async function deliverUserInvitations(env: Env, userIds?: string[]) {
  if (env.AUTH_INVITATION_EMAIL_ENABLED !== "1" || !env.AUTH_EMAIL?.send) return [];
  // Validate delivery configuration before claiming invitations. A missing or
  // invalid installation URL must not send people to another installation.
  const from = env.EMAIL_OTP_FROM?.trim();
  if (!from || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) return [];
  const portalUrl = publicHttpsUrl(env.PORTAL_URL || env.AUTH_PUBLIC_URL || "");
  const brand = platformBrandFromEnv(env);
  const policy = await readAuthEmailPolicy(env.AUTH_DB);
  const rows = userIds
    ? userIds.map(user_id => ({ user_id }))
    : (await env.AUTH_DB.prepare(`SELECT user_id FROM auth_user_invitation_emails WHERE status='pending' ORDER BY created_at LIMIT 50`).all<{ user_id: string }>()).results ?? [];
  for (const { user_id } of rows) {
    const claimed = await env.AUTH_DB.prepare(`
      UPDATE auth_user_invitation_emails SET status='sending',updated_at=CURRENT_TIMESTAMP
      WHERE user_id=? AND status='pending' RETURNING user_id
    `).bind(user_id).first<{ user_id: string }>();
    if (!claimed) continue;
    const user = await env.AUTH_DB.prepare(`SELECT email,name,status FROM auth_users WHERE id=?`)
      .bind(user_id).first<{ email: string; name: string; status: string }>();
    if (!user || user.status !== "invited" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) || !isEmailAllowedByPolicy(policy, user.email)) {
      await env.AUTH_DB.prepare(`UPDATE auth_user_invitation_emails SET status='cancelled',error_code='account_not_eligible',updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).bind(user_id).run();
      continue;
    }
    const to = user.email.trim().toLowerCase();
    await env.AUTH_DB.prepare(`UPDATE auth_user_invitation_emails SET recipient=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).bind(to, user_id).run();
    let providerAccepted = false;
    try {
      const result = await env.AUTH_EMAIL.send({
        from,
        to,
        ...renderInvitationEmail(user.name || "同事", to, portalUrl, brand)
      });
      if (result?.status?.toLowerCase() === "failed") {
        await env.AUTH_DB.prepare(`UPDATE auth_user_invitation_emails SET status='failed',error_code='provider_rejected',updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).bind(user_id).run();
        continue;
      }
      providerAccepted = true;
      await env.AUTH_DB.prepare(`UPDATE auth_user_invitation_emails SET status='sent',message_id=?,error_code=NULL,sent_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
        .bind(result?.messageId ?? null, user_id).run();
    } catch {
      await env.AUTH_DB.prepare(`UPDATE auth_user_invitation_emails SET status='uncertain',error_code=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
        .bind(providerAccepted ? "provider_accepted_receipt_not_saved" : "provider_result_unknown", user_id).run().catch(() => undefined);
    }
  }
  const result = userIds
    ? await env.AUTH_DB.prepare(`SELECT user_id,status,recipient,message_id,error_code,sent_at FROM auth_user_invitation_emails WHERE user_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(userIds)).all()
    : await env.AUTH_DB.prepare(`SELECT user_id,status,recipient,message_id,error_code,sent_at FROM auth_user_invitation_emails ORDER BY updated_at DESC LIMIT 50`).all();
  return result.results ?? [];
}

export async function deliverUserInvitationSafely(env: Env, userId: string) {
  await deliverUserInvitations(env, [userId]).catch(() => undefined);
}
