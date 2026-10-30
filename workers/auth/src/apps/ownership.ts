import { bearerToken, json, readJson } from '../http.ts';
import { safeEqual } from '../serviceAuthorization.ts';
import { HttpError, type Env } from '../types.ts';
import { requireText } from '../values.ts';

/** Narrow service endpoint: update existing ownership projections, never publish or change secrets. */
export async function handleAppsOwnershipRequest(request: Request, env: Env, requestId: string): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST' || !['/v1/internal/apps/owner-identity', '/v1/internal/apps/ownership-sync'].includes(path)) return undefined;
  const expected = env.APPS_AUTH_SERVICE_TOKEN?.trim();
  if (!expected || !safeEqual(expected, bearerToken(request))) throw new HttpError(401, 'invalid_service_token');
  const body = await readJson<Record<string, unknown>>(request);
  if (!env.WORKSPACE_ORG_ID || body.orgId !== env.WORKSPACE_ORG_ID) throw new HttpError(403, 'organization_mismatch');
  if (path.endsWith('/owner-identity')) {
    const identifier = requireText(body.userId, 'missing_user_id', 180).trim().toLowerCase();
    const user = await env.AUTH_DB.prepare('SELECT id, name, email, status FROM auth_users WHERE id = ? OR lower(email) = ? LIMIT 1')
      .bind(identifier, identifier).first<{ id: string; name: string; email: string; status: string }>();
    if (body.requireActive !== false && (!user || user.status !== 'active')) throw new HttpError(400, 'apps_owner_target_inactive');
    return json({ user, requestId });
  }
  const appId = requireText(body.appId, 'missing_app_id', 180);
  const ownerUserId = requireText(body.ownerUserId, 'missing_user_id', 180);
  const version = requireText(body.version, 'missing_policy_version', 180);
  if (!Array.isArray(body.collaboratorUserIds) || body.collaboratorUserIds.length > 200 || body.collaboratorUserIds.some(id => typeof id !== 'string' || !id || id.length > 180)) throw new HttpError(400, 'invalid_collaborator_user_ids');
  if (!Array.isArray(body.accessTargets) || body.accessTargets.length > 400 || body.accessTargets.some(id => typeof id !== 'string' || !id || id.length > 250)) throw new HttpError(400, 'invalid_access_targets');
  const collaborators = Array.from(new Set(body.collaboratorUserIds as string[])).filter(id => id !== ownerUserId);
  const targets = Array.from(new Set([...(body.accessTargets as string[]), ...collaborators.map(id => `user:${id}`)]));
  const now = new Date().toISOString();
  const statements = ['auth_app_clients', 'auth_resource_clients'].map((table, index) => env.AUTH_DB.prepare(`UPDATE ${table}
    SET publisher_user_id = ?, business_owner_user_id = ?, collaborator_user_ids_json = ?, access_targets_json = ?, system_role_policy_version = ?, updated_at = ? WHERE id = ?`)
    .bind(ownerUserId, ownerUserId, JSON.stringify(collaborators), JSON.stringify(targets), version, now, index ? `app-mcp:${appId}` : appId));
  statements.push(env.AUTH_DB.prepare(`INSERT OR IGNORE INTO auth_audit_events (id, actor_user_id, client_app_id, action, resource_type, resource_id, decision, metadata_json, created_at)
    VALUES (?, 'service:workspace-apps', ?, 'apps.ownership.synchronize', 'app', ?, 'allow', ?, ?)`)
    .bind(`apps-ownership:${appId}:${version}`, appId, appId, JSON.stringify({ ownerUserId, collaboratorUserIds: collaborators, version }), now));
  await env.AUTH_DB.batch(statements);
  return json({ synced: true, requestId });
}
