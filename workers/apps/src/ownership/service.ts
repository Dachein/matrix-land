import type { AppsOwnershipAsset, AppsOwnerTransfer } from '../../../../src/shared/appsOwnership.ts';
import { syncAppMail } from '../apps/mailService.ts';
import { collaboratorUserIdsFromJson, normalizeUserIdentifier, principalOwnsUserId, principalUserIdentifiers } from '../core/collaborators.ts';
import { HttpError, type Env, type Principal } from '../core/types.ts';
import type { AppsAppRow } from '../db/rows.ts';

type AssetType = 'app' | 'skill';
type AssetRow = { id: string; org_id: string; name: string; owner_user_id: string; collaborator_user_ids_json?: string; status: string; updated_at: string; ownership_sync_pending?: number; ownership_sync_lock_until?: string };
type TransferRow = { id: string; org_id: string; asset_type: AssetType; asset_id: string; asset_name: string; from_user_id: string; to_user_id: string; retain_previous_owner: number; status: AppsOwnerTransfer['status']; reason: string; expires_at: string };
const table = (type: AssetType) => type === 'app' ? 'apps_apps' : 'apps_skills';

export function assertOwnershipAdmin(principal: Principal) {
  // The ordinary apps:apps:admin scope is also issued to builders; it is not a platform role.
  if (principal.tokenType !== 'apps_access' || principal.platformRole !== 'admin' || !principal.scopes.includes('apps:ownership:admin')) {
    throw new HttpError(403, 'apps_ownership_admin_required');
  }
}

async function asset(env: Env, principal: Principal, type: AssetType, id: string) {
  const row = await env.APPS_DB.prepare(`SELECT * FROM ${table(type)} WHERE id = ? AND org_id = ? AND status <> 'archived'`).bind(id, principal.orgId).first<AssetRow>();
  if (!row) throw new HttpError(404, 'apps_ownership_asset_not_found');
  return row;
}

export async function listOwnershipAssets(env: Env, principal: Principal): Promise<AppsOwnershipAsset[]> {
  assertOwnershipAdmin(principal);
  const assets: AppsOwnershipAsset[] = [];
  for (const type of ['app', 'skill'] as const) {
    const rows = await env.APPS_DB.prepare(`SELECT id, name, owner_user_id, collaborator_user_ids_json, ownership_sync_pending FROM ${table(type)} WHERE org_id = ? AND status <> 'archived' ORDER BY name`).bind(principal.orgId).all<AssetRow>();
    for (const row of rows.results ?? []) assets.push({ id: row.id, type, name: row.name, ownerUserId: row.owner_user_id, collaboratorUserIds: collaboratorUserIdsFromJson(row.collaborator_user_ids_json), syncPending: row.ownership_sync_pending === 1 });
  }
  return assets;
}

type OwnerIdentity = { id: string; email: string; status: string };
async function identity(env: Env, orgId: string, userId: unknown, requireActive?: true): Promise<OwnerIdentity>;
async function identity(env: Env, orgId: string, userId: unknown, requireActive: false): Promise<OwnerIdentity | undefined>;
async function identity(env: Env, orgId: string, userId: unknown, requireActive = true): Promise<OwnerIdentity | undefined> {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 180) throw new HttpError(400, 'apps_owner_target_required');
  const token = env.APPS_AUTH_SERVICE_TOKEN?.trim();
  if (!token) throw new HttpError(503, 'auth_worker_not_configured');
  const request = new Request(`${env.AUTH_WORKER_URL || env.AUTH_ISSUER}/v1/internal/apps/owner-identity`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ userId, orgId, requireActive }), signal: AbortSignal.timeout(6000)
  });
  const response = await (env.AUTH_SERVICE ? env.AUTH_SERVICE.fetch(request) : fetch(request));
  if (!response.ok) throw new HttpError([400, 404].includes(response.status) ? 400 : 503, [400, 404].includes(response.status) ? 'apps_owner_target_inactive' : 'auth_worker_unavailable');
  const payload = await response.json() as { user: OwnerIdentity | null };
  if (!requireActive && !payload.user) return undefined;
  if (!payload.user?.id || (requireActive && payload.user.status !== 'active')) throw new HttpError(400, 'apps_owner_target_inactive');
  return payload.user;
}

function auditStatement(env: Env, principal: Principal, row: TransferRow, action: string) {
  return env.APPS_DB.prepare(`INSERT INTO apps_audit_logs (id, actor_user_id, org_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(`audit_${crypto.randomUUID()}`, principal.sub, principal.orgId, `apps.owner_transfer.${action}`, `apps_${row.asset_type}`, row.asset_id,
      JSON.stringify({ transferId: row.id, fromUserId: row.from_user_id, toUserId: row.to_user_id, retainPreviousOwner: row.retain_previous_owner === 1, reason: row.reason }), new Date().toISOString());
}

function transferJson(row: TransferRow): AppsOwnerTransfer {
  return { id: row.id, assetType: row.asset_type, assetId: row.asset_id, assetName: row.asset_name, fromUserId: row.from_user_id, toUserId: row.to_user_id, retainPreviousOwner: row.retain_previous_owner === 1, status: row.status, reason: row.reason, expiresAt: row.expires_at };
}

async function expire(env: Env, orgId: string) {
  await env.APPS_DB.prepare("UPDATE apps_owner_transfers SET status = 'expired', updated_at = ? WHERE org_id = ? AND status = 'pending' AND expires_at <= ?").bind(new Date().toISOString(), orgId, new Date().toISOString()).run();
}

export async function listOwnerTransfers(env: Env, principal: Principal): Promise<AppsOwnerTransfer[]> {
  await expire(env, principal.orgId);
  const identifiers = principalUserIdentifiers(principal);
  const rows = await env.APPS_DB.prepare(`SELECT * FROM apps_owner_transfers WHERE org_id = ? AND (from_user_id IN (${identifiers.map(() => '?').join(',')}) OR to_user_id = ?) ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 100`)
    .bind(principal.orgId, ...identifiers, principal.sub).all<TransferRow>();
  return (rows.results ?? []).map(transferJson);
}

export async function initiateOwnerTransfer(env: Env, principal: Principal, type: AssetType, id: string, body: Record<string, unknown>, forced = false) {
  if (forced) assertOwnershipAdmin(principal);
  const current = await asset(env, principal, type, id);
  if (!forced && !principalOwnsUserId(current.owner_user_id, principal)) throw new HttpError(403, 'apps_owner_transfer_denied');
  if (current.ownership_sync_pending) throw new HttpError(409, 'apps_ownership_sync_pending');
  const target = await identity(env, principal.orgId, body.toUserId);
  if ([target.id, target.email].map(normalizeUserIdentifier).includes(normalizeUserIdentifier(current.owner_user_id))) throw new HttpError(400, 'apps_owner_transfer_same_user');
  if (body.retainPreviousOwner !== undefined && typeof body.retainPreviousOwner !== 'boolean') throw new HttpError(400, 'apps_owner_transfer_invalid_retention');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if ((forced && !reason) || reason.length > 500) throw new HttpError(400, 'apps_owner_transfer_reason_required');
  await expire(env, principal.orgId);
  const now = new Date().toISOString();
  const row: TransferRow = { id: `ltransfer_${crypto.randomUUID()}`, org_id: principal.orgId, asset_type: type, asset_id: id, asset_name: current.name, from_user_id: current.owner_user_id, to_user_id: target.id,
    retain_previous_owner: body.retainPreviousOwner === false ? 0 : 1, status: forced ? 'admin_forced' : 'pending', reason, expires_at: new Date(Date.now() + 7 * 86400000).toISOString() };
  const insert = env.APPS_DB.prepare(`INSERT INTO apps_owner_transfers (id, org_id, asset_type, asset_id, asset_name, from_user_id, to_user_id, initiated_by_user_id, retain_previous_owner, status, reason, expires_at, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM ${table(type)} WHERE id = ? AND owner_user_id = ? AND updated_at = ? AND ownership_sync_pending = 0) THEN ? ELSE NULL END, ?, ?, ?, ?`)
    .bind(row.id, principal.orgId, type, id, current.name, current.owner_user_id, target.id, principal.sub, row.retain_previous_owner, id, current.owner_user_id, current.updated_at, row.status, reason, row.expires_at, now, now);
  if (forced) {
    await commitOwnership(env, principal, row, current, target.email, insert);
    return { transfer: transferJson(row), syncPending: !await synchronizeOwnership(env, type, id) };
  }
  try {
    const [result] = await env.APPS_DB.batch([insert, auditStatement(env, principal, row, 'initiate')]);
    if (!result.meta.changes) throw new HttpError(409, 'apps_owner_transfer_owner_changed');
  } catch (error) {
    if (error instanceof Error && /NOT NULL constraint failed: apps_owner_transfers.status/i.test(error.message)) throw new HttpError(409, 'apps_owner_transfer_owner_changed');
    if (error instanceof Error && /unique/i.test(error.message)) throw new HttpError(409, 'apps_owner_transfer_already_pending');
    throw error;
  }
  return { transfer: transferJson(row), syncPending: false };
}

export async function decideOwnerTransfer(env: Env, principal: Principal, id: string, action: 'accept' | 'reject' | 'cancel') {
  const row = await env.APPS_DB.prepare('SELECT * FROM apps_owner_transfers WHERE id = ? AND org_id = ?').bind(id, principal.orgId).first<TransferRow>();
  if (!row) throw new HttpError(404, 'apps_owner_transfer_not_found');
  const permitted = action === 'cancel' ? principalOwnsUserId(row.from_user_id, principal) : row.to_user_id === principal.sub;
  if (!permitted) throw new HttpError(403, 'apps_owner_transfer_denied');
  if (row.status === 'accepted' && action === 'accept') return { transfer: transferJson(row), syncPending: !await synchronizeOwnership(env, row.asset_type, row.asset_id) };
  if (row.status !== 'pending') throw new HttpError(409, 'apps_owner_transfer_not_pending');
  if (Date.parse(row.expires_at) <= Date.now()) { await expire(env, principal.orgId); throw new HttpError(409, 'apps_owner_transfer_expired'); }
  if (action !== 'accept') {
    const result = await env.APPS_DB.prepare("UPDATE apps_owner_transfers SET status = ?, decided_by_user_id = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .bind(action === 'reject' ? 'rejected' : 'cancelled', principal.sub, new Date().toISOString(), new Date().toISOString(), id).run();
    if (!result.meta.changes) throw new HttpError(409, 'apps_owner_transfer_not_pending');
    await auditStatement(env, principal, row, action).run();
    row.status = action === 'reject' ? 'rejected' : 'cancelled';
    return { transfer: transferJson(row), syncPending: false };
  }
  const target = await identity(env, principal.orgId, row.to_user_id);
  const current = await asset(env, principal, row.asset_type, row.asset_id);
  if (current.owner_user_id !== row.from_user_id) throw new HttpError(409, 'apps_owner_transfer_owner_changed');
  if (current.ownership_sync_pending) throw new HttpError(409, 'apps_ownership_sync_pending');
  await commitOwnership(env, principal, row, current, target.email);
  row.status = 'accepted';
  return { transfer: transferJson(row), syncPending: !await synchronizeOwnership(env, row.asset_type, row.asset_id) };
}

async function commitOwnership(env: Env, principal: Principal, row: TransferRow, current: AssetRow, targetEmail: string, insert?: D1PreparedStatement) {
  const previousVersion = Date.parse(current.updated_at);
  const now = new Date(Math.max(Date.now(), (Number.isFinite(previousVersion) ? previousVersion : 0) + 1)).toISOString();
  const statements: D1PreparedStatement[] = [];
  if (insert) {
    // An administrator supersedes the existing request in the same transaction.
    statements.push(env.APPS_DB.prepare("UPDATE apps_owner_transfers SET status = 'cancelled', decided_by_user_id = ?, decided_at = ?, updated_at = ? WHERE asset_type = ? AND asset_id = ? AND org_id = ? AND status = 'pending'").bind(principal.sub, now, now, row.asset_type, row.asset_id, principal.orgId), insert);
  }
  // Assigning NULL violates NOT NULL and rolls back the whole batch if another decision won.
  statements.push(env.APPS_DB.prepare(`UPDATE apps_owner_transfers SET status = CASE WHEN status = ? AND expires_at > ? AND EXISTS (
    SELECT 1 FROM ${table(row.asset_type)} WHERE id = ? AND owner_user_id = ? AND updated_at = ? AND ownership_sync_pending = 0 AND status <> 'archived'
  ) THEN ? ELSE NULL END, decided_by_user_id = ?, decided_at = ?, updated_at = ? WHERE id = ?`)
    .bind(insert ? 'admin_forced' : 'pending', now, row.asset_id, row.from_user_id, current.updated_at, insert ? 'admin_forced' : 'accepted', principal.sub, now, now, row.id));
  const previousOwner = await identity(env, principal.orgId, row.from_user_id, false);
  const ownerAliases = new Set([row.to_user_id, targetEmail, row.from_user_id, previousOwner?.id, previousOwner?.email].filter(Boolean).map(normalizeUserIdentifier));
  const collaborators = collaboratorUserIdsFromJson(current.collaborator_user_ids_json).filter(id => !ownerAliases.has(normalizeUserIdentifier(id)));
  if (row.retain_previous_owner && !collaborators.includes(row.from_user_id)) collaborators.push(row.from_user_id);
  if (collaborators.length > 200) throw new HttpError(400, 'too_many_collaborators');
  statements.push(env.APPS_DB.prepare(`UPDATE ${table(row.asset_type)} SET owner_user_id = ?, collaborator_user_ids_json = ?, ownership_sync_pending = 1, ownership_sync_lock_until = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ? AND updated_at = ?`)
    .bind(row.to_user_id, JSON.stringify(collaborators), now, row.asset_id, row.from_user_id, current.updated_at), auditStatement(env, principal, row, insert ? 'admin_force' : 'accept'));
  try {
    await env.APPS_DB.batch(statements);
  } catch (error) {
    if (error instanceof Error && /NOT NULL constraint failed: apps_owner_transfers.status/i.test(error.message)) throw new HttpError(409, 'apps_owner_transfer_owner_changed');
    throw error;
  }
}

export async function synchronizeOwnership(env: Env, type: AssetType, id: string) {
  const lease = new Date(Date.now() + 120000).toISOString();
  const claimed = await env.APPS_DB.prepare(`UPDATE ${table(type)} SET ownership_sync_lock_until = ? WHERE id = ? AND ownership_sync_pending = 1 AND (ownership_sync_lock_until IS NULL OR ownership_sync_lock_until < ?) RETURNING *`)
    .bind(lease, id, new Date().toISOString()).first<AppsAppRow & AssetRow>();
  if (!claimed) {
    const row = await env.APPS_DB.prepare(`SELECT ownership_sync_pending FROM ${table(type)} WHERE id = ?`).bind(id).first<AssetRow>();
    return row?.ownership_sync_pending === 0;
  }
  try {
    if (type === 'app') {
      const token = env.APPS_AUTH_SERVICE_TOKEN?.trim();
      if (!token) throw new HttpError(503, 'auth_worker_not_configured');
      const request = new Request(`${env.AUTH_WORKER_URL || env.AUTH_ISSUER}/v1/internal/apps/ownership-sync`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ orgId: claimed.org_id, appId: id, ownerUserId: claimed.owner_user_id, collaboratorUserIds: collaboratorUserIdsFromJson(claimed.collaborator_user_ids_json), accessTargets: claimed.status === 'published' ? JSON.parse(claimed.access_targets_json || '[]') : [], version: claimed.updated_at })
      });
      const response = await (env.AUTH_SERVICE ? env.AUTH_SERVICE.fetch(request) : fetch(request));
      if (!response.ok) throw new HttpError(503, 'apps_ownership_sync_pending');
      const mail = await env.APPS_DB.prepare("SELECT 1 FROM apps_app_resources WHERE app_id = ? AND type IN ('email_sending', 'email_routing') LIMIT 1").bind(id).first();
      if (mail) await syncAppMail(env, { sub: claimed.owner_user_id, orgId: claimed.org_id, orgSlug: claimed.org_slug, scopes: [] }, claimed);
    }
    await env.APPS_DB.prepare(`UPDATE ${table(type)} SET ownership_sync_pending = 0, ownership_sync_lock_until = NULL WHERE id = ? AND ownership_sync_lock_until = ?`).bind(id, lease).run();
    return true;
  } catch {
    await env.APPS_DB.prepare(`UPDATE ${table(type)} SET ownership_sync_lock_until = NULL WHERE id = ? AND ownership_sync_lock_until = ?`).bind(id, lease).run();
    console.warn(JSON.stringify({ event: 'apps_ownership_sync_pending', assetType: type, assetId: id }));
    return false;
  }
}

export async function retryPendingOwnership(env: Env) {
  for (const type of ['app', 'skill'] as const) {
    const rows = await env.APPS_DB.prepare(`SELECT id FROM ${table(type)} WHERE ownership_sync_pending = 1 LIMIT 20`).all<{ id: string }>();
    for (const row of rows.results ?? []) await synchronizeOwnership(env, type, row.id);
  }
}
