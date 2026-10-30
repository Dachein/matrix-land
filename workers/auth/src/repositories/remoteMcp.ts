import { HttpError, type Env } from '../types.ts';

export type RemoteConnection = {
  id: string; org_id: string; user_id: string; name: string; server_url: string; status: string;
  generation: number; credential_ciphertext: string | null; credential_expires_at: number;
  refresh_lease_until: number; connected_at: string | null; updated_at: string;
};
export type RemoteState = { connection_id: string; user_id: string; generation: number; context_ciphertext: string };
export function listRemoteConnections(env: Env, orgId: string, userId: string, mateId = '') {
  return env.AUTH_DB.prepare(`SELECT connection.* FROM auth_remote_mcp_connections AS connection
    WHERE org_id = ? AND user_id = ? AND (? = '' OR EXISTS (SELECT 1 FROM auth_remote_mcp_bindings
    WHERE connection_id = connection.id AND mate_id = ?)) ORDER BY updated_at DESC LIMIT 32`)
    .bind(orgId, userId, mateId, mateId).all<RemoteConnection>();
}
export async function requireRemoteConnection(env: Env, orgId: string, userId: string, id: string) {
  const row = await env.AUTH_DB.prepare(`SELECT * FROM auth_remote_mcp_connections
    WHERE id = ? AND org_id = ? AND user_id = ?`).bind(id, orgId, userId).first<RemoteConnection>();
  if (!row) throw new HttpError(404, 'remote_mcp_connection_not_found');
  return row;
}
export async function createRemoteConnection(env: Env, orgId: string, userId: string, name: string, url: string) {
  const existing = await env.AUTH_DB.prepare('SELECT * FROM auth_remote_mcp_connections WHERE org_id = ? AND user_id = ? AND server_url = ?')
    .bind(orgId, userId, url).first<RemoteConnection>();
  if (existing) return existing;
  const count = await env.AUTH_DB.prepare('SELECT COUNT(*) AS count FROM auth_remote_mcp_connections WHERE org_id = ? AND user_id = ?')
    .bind(orgId, userId).first<{ count: number }>();
  if ((count?.count || 0) >= 32) throw new HttpError(409, 'remote_mcp_connection_limit');
  const id = crypto.randomUUID();
  await env.AUTH_DB.prepare(`INSERT INTO auth_remote_mcp_connections (id, org_id, user_id, name, server_url)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(org_id,user_id,server_url) DO NOTHING`).bind(id, orgId, userId, name, url).run();
  return (await env.AUTH_DB.prepare('SELECT * FROM auth_remote_mcp_connections WHERE org_id = ? AND user_id = ? AND server_url = ?')
    .bind(orgId, userId, url).first<RemoteConnection>())!;
}
export async function beginRemoteConnect(env: Env, row: RemoteConnection) {
  const pending = await env.AUTH_DB.prepare(`UPDATE auth_remote_mcp_connections SET generation = generation + 1,
    status = 'connecting', credential_ciphertext = NULL, credential_expires_at = 0,
    refresh_lease_until = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'connected' RETURNING *`)
    .bind(row.id).first<RemoteConnection>();
  if (pending) await env.AUTH_DB.prepare(`DELETE FROM auth_remote_mcp_bindings WHERE connection_id = ?
    AND EXISTS (SELECT 1 FROM auth_remote_mcp_connections WHERE id = ? AND generation = ? AND status = 'connecting')`)
    .bind(row.id, row.id, pending.generation).run();
  return pending;
}
export function saveRemoteState(env: Env, row: RemoteConnection, hash: string, encrypted: string) {
  return env.AUTH_DB.batch([
    env.AUTH_DB.prepare(`DELETE FROM auth_remote_mcp_states WHERE expires_at < ? OR (connection_id = ? AND EXISTS
      (SELECT 1 FROM auth_remote_mcp_connections WHERE id = ? AND generation = ? AND status = 'connecting'))`)
      .bind(Date.now(), row.id, row.id, row.generation),
    env.AUTH_DB.prepare(`INSERT INTO auth_remote_mcp_states (state_hash, connection_id, user_id, generation, context_ciphertext, expires_at)
      SELECT ?, ?, ?, ?, ?, ? FROM auth_remote_mcp_connections WHERE id = ? AND generation = ? AND status = 'connecting'`)
      .bind(hash, row.id, row.user_id, row.generation, encrypted, Date.now() + 600000, row.id, row.generation)
  ]);
}
export function consumeRemoteState(env: Env, hash: string, userId: string) {
  return env.AUTH_DB.prepare(`UPDATE auth_remote_mcp_states SET consumed_at = ? WHERE state_hash = ?
    AND user_id = ? AND consumed_at IS NULL AND expires_at > ? RETURNING *`)
    .bind(Date.now(), hash, userId, Date.now()).first<RemoteState>();
}
export function finishRemoteConnect(env: Env, row: RemoteConnection, ciphertext: string, expiresAt: number) {
  return env.AUTH_DB.prepare(`UPDATE auth_remote_mcp_connections SET status = 'connected', credential_ciphertext = ?,
    credential_expires_at = ?, connected_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND generation = ? AND status = 'connecting'`).bind(ciphertext, expiresAt, row.id, row.generation).run();
}
export function cancelRemoteConnect(env: Env, row: RemoteConnection) {
  return env.AUTH_DB.prepare(`UPDATE auth_remote_mcp_connections SET status = 'disconnected', credential_ciphertext = NULL,
    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND generation = ? AND status = 'connecting'`).bind(row.id, row.generation).run();
}
export function disconnectRemoteConnection(env: Env, row: RemoteConnection) {
  return env.AUTH_DB.batch([
    env.AUTH_DB.prepare(`UPDATE auth_remote_mcp_connections SET status = 'disconnected', generation = generation + 1,
      credential_ciphertext = NULL, credential_expires_at = 0, refresh_lease_until = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(row.id),
    env.AUTH_DB.prepare('DELETE FROM auth_remote_mcp_states WHERE connection_id = ?').bind(row.id),
    env.AUTH_DB.prepare('DELETE FROM auth_remote_mcp_bindings WHERE connection_id = ?').bind(row.id)
  ]);
}
export function claimRemoteRefresh(env: Env, row: RemoteConnection) {
  return env.AUTH_DB.prepare(`UPDATE auth_remote_mcp_connections SET refresh_lease_until = ? WHERE id = ? AND generation = ?
    AND status = 'connected' AND refresh_lease_until < ? AND credential_ciphertext = ? RETURNING *`)
    .bind(Date.now() + 30000, row.id, row.generation, Date.now(), row.credential_ciphertext).first<RemoteConnection>();
}
export function finishRemoteRefresh(env: Env, row: RemoteConnection, encrypted: string, expiresAt: number) {
  return env.AUTH_DB.prepare(`UPDATE auth_remote_mcp_connections SET credential_ciphertext = ?, credential_expires_at = ?,
    refresh_lease_until = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND generation = ? AND status = 'connected'
    AND credential_ciphertext = ?`).bind(encrypted, expiresAt, row.id, row.generation, row.credential_ciphertext).run();
}
export function failRemoteRefresh(env: Env, row: RemoteConnection, reauth: boolean) {
  return env.AUTH_DB.prepare(`UPDATE auth_remote_mcp_connections SET refresh_lease_until = 0,
    status = CASE WHEN ? THEN 'needs_reauth' ELSE status END,
    credential_ciphertext = CASE WHEN ? THEN NULL ELSE credential_ciphertext END, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND generation = ? AND status = 'connected' AND credential_ciphertext = ?`)
    .bind(reauth ? 1 : 0, reauth ? 1 : 0, row.id, row.generation, row.credential_ciphertext).run();
}
export async function remoteBindingExists(env: Env, id: string, mateId: string) {
  return Boolean(await env.AUTH_DB.prepare('SELECT 1 FROM auth_remote_mcp_bindings WHERE connection_id = ? AND mate_id = ?').bind(id, mateId).first());
}
export async function remoteBindingApproval(env: Env, id: string, mateId: string) {
  const row = await env.AUTH_DB.prepare('SELECT approved_tools_json FROM auth_remote_mcp_bindings WHERE connection_id = ? AND mate_id = ?')
    .bind(id, mateId).first<{ approved_tools_json: string }>();
  return row?.approved_tools_json || '{}';
}
export function installRemoteConnection(env: Env, row: RemoteConnection, mateId: string) {
  return env.AUTH_DB.prepare('INSERT OR IGNORE INTO auth_remote_mcp_installations(connection_id,mate_id) VALUES (?,?)')
    .bind(row.id, mateId).run();
}
export function listRemoteInstallations(env: Env, orgId: string, userId: string, mateId: string) {
  return env.AUTH_DB.prepare(`SELECT connection.*, installation.last_tested_at, installation.last_error_code, installation.tool_count
    FROM auth_remote_mcp_connections connection JOIN auth_remote_mcp_installations installation ON installation.connection_id = connection.id
    WHERE connection.org_id = ? AND connection.user_id = ? AND installation.mate_id = ? ORDER BY installation.installed_at DESC`)
    .bind(orgId, userId, mateId).all<RemoteConnection & { last_tested_at: string | null; last_error_code: string | null; tool_count: number }>();
}
export function recordRemoteTest(env: Env, row: RemoteConnection, mateId: string, toolCount: number, errorCode: string | null) {
  return env.AUTH_DB.prepare(`UPDATE auth_remote_mcp_installations SET last_tested_at = CURRENT_TIMESTAMP,
    last_error_code = ?, tool_count = ? WHERE connection_id = ? AND mate_id = ? AND EXISTS
    (SELECT 1 FROM auth_remote_mcp_connections WHERE id = ? AND generation = ?)`)
    .bind(errorCode, toolCount, row.id, mateId, row.id, row.generation).run();
}
export async function removeRemoteInstallation(env: Env, row: RemoteConnection, mateId: string) {
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('DELETE FROM auth_remote_mcp_bindings WHERE connection_id = ? AND mate_id = ?').bind(row.id, mateId),
    env.AUTH_DB.prepare('DELETE FROM auth_remote_mcp_installations WHERE connection_id = ? AND mate_id = ?').bind(row.id, mateId),
    env.AUTH_DB.prepare(`UPDATE auth_remote_mcp_connections SET generation = generation + 1, status = 'disconnected',
      credential_ciphertext = NULL, credential_expires_at = 0 WHERE id = ? AND NOT EXISTS
      (SELECT 1 FROM auth_remote_mcp_installations WHERE connection_id = ?)` ).bind(row.id, row.id),
    env.AUTH_DB.prepare(`DELETE FROM auth_remote_mcp_states WHERE connection_id = ? AND NOT EXISTS
      (SELECT 1 FROM auth_remote_mcp_installations WHERE connection_id = ?)` ).bind(row.id, row.id),
    env.AUTH_DB.prepare(`DELETE FROM auth_remote_mcp_connections WHERE id = ? AND NOT EXISTS
      (SELECT 1 FROM auth_remote_mcp_installations WHERE connection_id = ?)` ).bind(row.id, row.id)
  ]);
}
export function saveRemoteBinding(env: Env, row: RemoteConnection, mateId: string, approved: string, enabled: boolean) {
  return env.AUTH_DB.batch([
    env.AUTH_DB.prepare(`UPDATE auth_remote_mcp_connections SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND generation = ? AND status = 'connected'`).bind(row.id, row.generation),
    enabled ? env.AUTH_DB.prepare(`INSERT INTO auth_remote_mcp_bindings (connection_id,mate_id,approved_tools_json)
      SELECT id, ?, ? FROM auth_remote_mcp_connections WHERE id = ? AND status = 'connected' AND generation = ?
      ON CONFLICT(connection_id,mate_id) DO UPDATE SET approved_tools_json = excluded.approved_tools_json`)
      .bind(mateId, approved, row.id, row.generation)
      : env.AUTH_DB.prepare('DELETE FROM auth_remote_mcp_bindings WHERE connection_id = ? AND mate_id = ?').bind(row.id, mateId)
  ]);
}
