import { sha256 } from '../crypto.ts';
import { requireAuthoritativeSessionUser } from '../identity/users.ts';
import { HttpError, type Env } from '../types.ts';

export async function instanceOwnership(request: Request, env: Env) {
 const user = await requireAuthoritativeSessionUser(request, env);
 const owner = await env.AUTH_DB.prepare('SELECT user_id FROM workspace_ownership WHERE id = 1').first<{user_id: string}>();
 return Response.json({isOwner: owner?.user_id === user.id, claimAvailable: !owner}, {headers: {'Cache-Control': 'no-store'}});
}
function requireSameOrigin(request: Request, env: Env) {
 let expected: string;
 try { expected = new URL(env.PORTAL_URL ?? '').origin; } catch { throw new HttpError(503, 'portal_url_not_configured'); }
 if (request.headers.get('Origin') !== expected) throw new HttpError(403, 'invalid_request_origin');
}
export async function claimInstanceOwnership(request: Request, env: Env) {
 requireSameOrigin(request, env);
 const user = await requireAuthoritativeSessionUser(request, env);
 const body = await request.json() as {token?: unknown};
 if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) throw new HttpError(400, 'invalid_claim_token');
 const now = Math.floor(Date.now() / 1000);
 const result = await env.AUTH_DB.prepare(`INSERT INTO workspace_ownership(id,user_id,claimed_at)
 SELECT 1, ?, ? FROM workspace_bootstrap_claim c
 JOIN auth_users u ON u.id = ? AND lower(u.email) = lower(c.email) AND u.status = 'active'
 WHERE c.id = 1 AND c.token_hash = ? AND c.expires_at > ? AND c.consumed_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM workspace_ownership)
 ON CONFLICT(id) DO NOTHING`).bind(user.id, now, user.id, await sha256(body.token), now).run();
 if (!result.meta.changes) throw new HttpError(403, 'claim_expired_used_or_identity_mismatch');
 return Response.json({claimed: true}, {headers: {'Cache-Control': 'no-store'}});
}
export async function transferInstanceOwnership(request: Request, env: Env) {
 requireSameOrigin(request, env);
 const user = await requireAuthoritativeSessionUser(request, env);
 const body = await request.json() as {userId?: unknown};
 if (typeof body.userId !== 'string' || !body.userId || body.userId.length > 200 || body.userId === user.id) throw new HttpError(400, 'invalid_owner_target');
 const result = await env.AUTH_DB.prepare(`UPDATE workspace_ownership SET user_id = ?
 WHERE id = 1 AND user_id = ? AND EXISTS(SELECT 1 FROM auth_users WHERE id = ? AND status = 'active')`)
 .bind(body.userId,user.id,body.userId).run();
 if (!result.meta.changes) throw new HttpError(403, 'owner_transfer_not_authorized');
 return Response.json({transferred: true}, {headers: {'Cache-Control': 'no-store'}});
}
