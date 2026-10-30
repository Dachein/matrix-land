import { authPublicUrl } from '../configuration.ts';
import { sha256 } from '../crypto.ts';
import { bearerToken, json, readJson } from '../http.ts';
import { requireAuthoritativeSessionUser } from '../identity/users.ts';
import { openCredential, sealCredential } from './credentials.ts';
import { recordAuditEvent } from '../repositories/audit.ts';
import { resolveAuthoritativeAuthUserSnapshot } from '../repositories/users/login.ts';
import * as repository from '../repositories/remoteMcp.ts';
import { safeEqual } from '../serviceAuthorization.ts';
import { HttpError, type Env } from '../types.ts';
import { remoteFetch, remoteUrl } from './network.ts';
import { discoverRemoteOAuth, exchangeRemoteToken, remoteAuthorizationUrl, remoteClientMetadata, type OAuthContext, type RemoteCredential } from './oauth.ts';
import { listRemoteTools, RemoteAuthorizationRequired, withRemoteMcp, type RemoteTool } from './transport.ts';
import { requireMateOwner } from './owner.ts';

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
type Approval = { digest: string; readOnly: boolean };
export function remoteMcpEnabled(env: Env) {
  return env.REMOTE_MCP_ENABLED === '1' && (env.THIRD_PARTY_CREDENTIAL_KEY?.length || 0) >= 32 && Boolean(env.MATE_MCP_SERVICE_TOKEN);
}
const owner = (row: repository.RemoteConnection) => `${row.org_id}:${row.user_id}:remote-mcp:${row.id}`;
function org(env: Env) { if (!env.WORKSPACE_ORG_ID) throw new HttpError(503, 'workspace_org_not_configured'); return env.WORKSPACE_ORG_ID; }
function enabled(env: Env) { if (!remoteMcpEnabled(env)) throw new HttpError(503, 'remote_mcp_not_configured'); }
function publicRow(row: repository.RemoteConnection) {
  return { id: row.id, name: row.name, serverUrl: row.server_url, status: row.status,
    generation: row.generation, connectedAt: row.connected_at, updatedAt: row.updated_at };
}
function mutation(request: Request, env: Env) {
  const origin = request.headers.get('origin');
  if (!origin || ![authPublicUrl(env),env.PORTAL_URL].filter(Boolean).some(value => new URL(value!).origin === origin))
    throw new HttpError(403, 'remote_mcp_origin_denied');
  if (!request.headers.get('content-type')?.includes('application/json')) throw new HttpError(415, 'json_required');
}
async function audit(env: Env, row: repository.RemoteConnection, action: string, requestId: string, metadata: Record<string, unknown> = {}) {
  await recordAuditEvent(env, { actorUserId: row.user_id, action, resourceType: 'remote_mcp_connection', resourceId: row.id, requestId, metadata });
}
const mateId = (value: unknown) => {
  if (typeof value !== 'string' || !/^[\w-]{1,160}$/.test(value)) throw new HttpError(400, 'remote_mcp_mate_invalid');
  return value;
};
export async function toolDigest(value: RemoteTool) { return sha256(JSON.stringify(value)); }
async function advertisedTools(tools: RemoteTool[], row: repository.RemoteConnection, approvedJson = '{}') {
  const approved = JSON.parse(approvedJson) as Record<string, Approval>;
  return Promise.all(tools.map(async tool => {
    const digest = await toolDigest(tool), selected = approved[tool.name];
    return { ...tool, digest, enabled: selected?.digest === digest,
      readOnly: selected?.digest === digest && selected.readOnly === true };
  }));
}

export async function remoteCredential(env: Env, initial: repository.RemoteConnection) {
  let row = initial;
  if (row.status !== 'connected' || !row.credential_ciphertext) throw new HttpError(409, 'remote_mcp_not_connected');
  let credential = await openCredential<RemoteCredential>(env, owner(row), row.credential_ciphertext);
  if (!credential.oauth || row.credential_expires_at > Date.now() + 60000) return { row, credential };
  if (!await repository.claimRemoteRefresh(env, row)) {
    const latest = await repository.requireRemoteConnection(env, row.org_id, row.user_id, row.id);
    if (latest.status === 'connected' && latest.generation === row.generation && latest.credential_ciphertext
      && latest.credential_expires_at > Date.now() + 60000)
      return { row: latest, credential: await openCredential<RemoteCredential>(env, owner(latest), latest.credential_ciphertext) };
    throw new HttpError(409, 'remote_mcp_refresh_in_progress');
  }
  try {
    if (!credential.refreshToken) throw new HttpError(401, 'remote_mcp_reauthorization_required');
    credential = await exchangeRemoteToken(env, credential.oauth, { grant_type: 'refresh_token', refresh_token: credential.refreshToken }, credential.refreshToken);
    const saved = await repository.finishRemoteRefresh(env, row, await sealCredential(env, owner(row), credential), credential.expiresAt);
    if (!saved.meta.changes) throw new HttpError(409, 'remote_mcp_connection_changed');
    row = await repository.requireRemoteConnection(env, row.org_id, row.user_id, row.id);
    return { row, credential };
  } catch (error) {
    await repository.failRemoteRefresh(env, row, error instanceof HttpError && error.status === 401); throw error;
  }
}

async function useConnection<T>(env: Env, initial: repository.RemoteConnection,
  callback: (rpc: (method: string, params?: Record<string, unknown>) => Promise<any>, row: repository.RemoteConnection) => Promise<T>) {
  const { row, credential } = await remoteCredential(env, initial);
  try {
    const result = await withRemoteMcp(env, row.server_url, credential.accessToken, rpc => callback(rpc, row));
    const current = await repository.requireRemoteConnection(env, row.org_id, row.user_id, row.id);
    if (current.generation !== row.generation || current.status !== 'connected') throw new HttpError(409, 'remote_mcp_connection_changed');
    return result;
  } catch (error) {
    if (error instanceof RemoteAuthorizationRequired) await repository.failRemoteRefresh(env, row, true);
    throw error;
  }
}

export async function handleRemoteMcpRequest(request: Request, env: Env, requestId: string): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === '/auth/remote-mcp/client-metadata.json' && request.method === 'GET')
    return json(remoteClientMetadata(env), { headers: { 'Cache-Control': 'public, max-age=300' } });
  if (url.pathname.startsWith('/v1/internal/remote-mcp/')) return internal(request, env, requestId);
  if (!url.pathname.startsWith('/auth/remote-mcp/')) return;
  const user = await requireAuthoritativeSessionUser(request, env), orgId = org(env);
  if (url.pathname === '/auth/remote-mcp/connections') {
    if (request.method === 'GET') {
      const target = mateId(url.searchParams.get('mateId'));
      await requireMateOwner(env, orgId, user.id, target);
      const rows = await repository.listRemoteInstallations(env, orgId, user.id, target);
      return json({ available: remoteMcpEnabled(env), connections: await Promise.all((rows.results || []).map(async row => ({
        ...publicRow(row), lastTestedAt: row.last_tested_at, lastErrorCode: row.last_error_code, toolCount: row.tool_count,
        enabledForMate: await repository.remoteBindingExists(env, row.id, target)
      }))) }, { headers });
    }
    if (request.method === 'POST') {
      mutation(request, env); enabled(env);
      const body = await readJson<{ name?: string; serverUrl?: string; mateId?: string }>(request);
      const target = mateId(body.mateId);
      await requireMateOwner(env, orgId, user.id, target);
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120 || typeof body.serverUrl !== 'string')
        throw new HttpError(400, 'remote_mcp_connection_invalid');
      const row = await repository.createRemoteConnection(env, orgId, user.id, body.name.trim(), remoteUrl(body.serverUrl, env));
      await repository.installRemoteConnection(env, row, target);
      await audit(env, row, 'remote_mcp_connection_created', requestId);
      return json({ connection: publicRow(row) }, { status: 201, headers });
    }
  }
  if (url.pathname === '/auth/remote-mcp/callback' && request.method === 'GET') {
    enabled(env);
    const state = url.searchParams.get('state');
    if (!state || state.length > 200) throw new HttpError(400, 'remote_mcp_state_invalid');
    const pending = await repository.consumeRemoteState(env, await sha256(state), user.id);
    if (!pending) throw new HttpError(400, 'remote_mcp_state_invalid');
    const row = await repository.requireRemoteConnection(env, orgId, user.id, pending.connection_id);
    if (row.status !== 'connecting' || row.generation !== pending.generation) throw new HttpError(400, 'remote_mcp_state_invalid');
    const redirect = new URL(authPublicUrl(env)); redirect.hash = '/mate';
    try {
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || !code || code.length > 4096) throw new HttpError(400, 'remote_mcp_authorization_denied');
      const context = await openCredential<OAuthContext>(env, owner(row), pending.context_ciphertext);
      if (!context.mateId) throw new HttpError(400, 'remote_mcp_mate_invalid');
      await requireMateOwner(env, orgId, user.id, context.mateId);
      if (context.mateId) redirect.hash = `/mate?mate=${encodeURIComponent(context.mateId)}`;
      if (context.conversationId) redirect.hash += `&conversation=${encodeURIComponent(context.conversationId)}`;
      if (context.state !== state || context.resource !== row.server_url) throw new HttpError(400, 'remote_mcp_state_invalid');
      const credential = await exchangeRemoteToken(env, context, { grant_type: 'authorization_code', code,
        code_verifier: context.verifier, redirect_uri: context.redirectUri });
      // A token response alone is insufficient: verify it reaches this resource.
      await withRemoteMcp(env, row.server_url, credential.accessToken, listRemoteTools);
      const saved = await repository.finishRemoteConnect(env, row, await sealCredential(env, owner(row), credential), credential.expiresAt);
      if (!saved.meta.changes) throw new HttpError(409, 'remote_mcp_connection_changed');
      await audit(env, row, 'remote_mcp_connected', requestId);
      redirect.searchParams.set('remoteMcp', row.id);
      redirect.searchParams.set('remoteMcpReturn', crypto.randomUUID());
    } catch {
      await repository.cancelRemoteConnect(env, row); await audit(env, row, 'remote_mcp_connect_failed', requestId);
      redirect.searchParams.set('remoteMcp', 'failed');
    }
    return new Response(null, { status: 303, headers: { ...headers, Location: redirect.toString() } });
  }
  const matched = url.pathname.match(/^\/auth\/remote-mcp\/connections\/([\w-]+)\/(connect|tools|binding|disconnect|remove)$/);
  if (!matched) throw new HttpError(404, 'remote_mcp_route_not_found');
  const row = await repository.requireRemoteConnection(env, orgId, user.id, matched[1]);
  if (request.method === 'GET' && matched[2] === 'tools') {
    enabled(env);
    await requireMateOwner(env, orgId, user.id, mateId(url.searchParams.get('mateId')));
    return json({ connection: publicRow(row), tools: await useConnection(env, row, async (rpc, current) => advertisedTools(await listRemoteTools(rpc), current, await repository.remoteBindingApproval(env, row.id, mateId(url.searchParams.get('mateId'))))) }, { headers });
  }
  if (request.method !== 'POST') throw new HttpError(405, 'remote_mcp_method_not_allowed');
  mutation(request, env);
  const body = await readJson<Record<string, any>>(request);
  const target = mateId(body.mateId);
  await requireMateOwner(env, orgId, user.id, target);
  if (matched[2] === 'remove') {
    await repository.removeRemoteInstallation(env, row, target);
    await audit(env, row, 'remote_mcp_plugin_removed', requestId, { mateId: target });
    return json({ removed: true }, { headers });
  }
  if (matched[2] === 'disconnect') {
    await repository.disconnectRemoteConnection(env, row);
    let providerRevoked = false;
    if (row.credential_ciphertext) try {
      const credential = await openCredential<RemoteCredential>(env, owner(row), row.credential_ciphertext);
      if (credential.oauth?.revocationEndpoint && credential.accessToken) {
        // Revocation is best effort; clearing local credentials always stops Mate calls.
        const form = new URLSearchParams({ token: credential.refreshToken || credential.accessToken });
        const revocationHeaders: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (credential.oauth.authMethod === 'client_secret_basic') {
          const encode = (value: string) => new URLSearchParams({ x: value }).toString().slice(2);
          revocationHeaders.Authorization = `Basic ${btoa(`${encode(credential.oauth.clientId)}:${encode(credential.oauth.clientSecret!)}`)}`;
        } else {
          form.set('client_id', credential.oauth.clientId);
          if (credential.oauth.authMethod === 'client_secret_post') form.set('client_secret', credential.oauth.clientSecret!);
        }
        await remoteFetch(env, credential.oauth.revocationEndpoint, { method: 'POST', headers: revocationHeaders, body: form })
          .then(async response => { providerRevoked = response.ok; await response.body?.cancel(); });
      } else if (!credential.oauth) providerRevoked = true;
    } catch { /* Local authority has already been revoked. */ }
    await audit(env, row, 'remote_mcp_disconnected', requestId);
    return json({ disconnected: true, providerRevoked }, { headers });
  }
  enabled(env);
  if (matched[2] === 'connect') {
    return json(await startConnection(env, row, target, requestId), { headers });
  }
  if (matched[2] === 'binding') {
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'remote_mcp_binding_invalid');
    const approved: Record<string, Approval> = Object.create(null);
    if (body.enabled) {
      if (!Array.isArray(body.tools) || body.tools.length > 64) throw new HttpError(400, 'remote_mcp_binding_invalid');
      const tools = await useConnection(env, row, rpc => listRemoteTools(rpc));
      for (const choice of body.tools) {
        const tool = tools.find(tool => tool.name === choice.name);
        if (!tool || await toolDigest(tool) !== choice.digest || typeof choice.readOnly !== 'boolean' || Object.hasOwn(approved, choice.name))
          throw new HttpError(409, 'remote_mcp_tool_changed');
        approved[choice.name] = { digest: choice.digest, readOnly: choice.readOnly };
      }
    }
    const saved = await repository.saveRemoteBinding(env, row, target, JSON.stringify(approved), body.enabled);
    if (!saved[0].meta.changes) throw new HttpError(409, 'remote_mcp_connection_changed');
    await audit(env, row, 'remote_mcp_binding_updated', requestId, { mateId: target, toolNames: Object.keys(approved) });
    return json({ saved: true }, { headers });
  }
  throw new HttpError(404, 'remote_mcp_route_not_found');
}

async function internal(request: Request, env: Env, requestId: string) {
  if (!env.MATE_MCP_SERVICE_TOKEN || !safeEqual(bearerToken(request), env.MATE_MCP_SERVICE_TOKEN))
    throw new HttpError(401, 'remote_mcp_service_token_invalid');
  enabled(env);
  if (request.method !== 'POST') throw new HttpError(405, 'remote_mcp_method_not_allowed');
  const body = await readJson<{ userId?: string; orgId?: string; mateId?: string; connectionId?: string; generation?: number;
    toolName?: string; digest?: string; arguments?: Record<string, unknown>; approved?: boolean;
    action?: string; name?: string; serverUrl?: string; conversationId?: string; tools?: Array<{ name: string; digest: string; readOnly: boolean }> }>(request);
  if (body.orgId !== org(env)) throw new HttpError(403, 'remote_mcp_org_mismatch');
  const user = await resolveAuthoritativeAuthUserSnapshot(env, { id: body.userId || '' });
  if (user.status !== 'active') throw new HttpError(403, 'auth_user_inactive');
  const target = mateId(body.mateId), path = new URL(request.url).pathname;
  await requireMateOwner(env, org(env), user.id, target);
  if (path === '/v1/internal/remote-mcp/manage') {
    if (body.action === 'list') {
      const rows = await repository.listRemoteInstallations(env, org(env), user.id, target);
      return json({ connections: await Promise.all((rows.results || []).map(async row => ({ ...publicRow(row),
        enabledForMate: await repository.remoteBindingExists(env, row.id, target), lastTestedAt: row.last_tested_at,
        lastErrorCode: row.last_error_code, toolCount: row.tool_count }))) }, { headers });
    }
    if (body.action === 'install') {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120 || typeof body.serverUrl !== 'string')
        throw new HttpError(400, 'remote_mcp_connection_invalid');
      const row = await repository.createRemoteConnection(env, org(env), user.id, body.name.trim(), remoteUrl(body.serverUrl, env));
      await repository.installRemoteConnection(env, row, target);
      await audit(env, row, 'remote_mcp_plugin_installed', requestId, { mateId: target });
      return json({ connection: publicRow(row), ...await startConnection(env, row, target, requestId, body.conversationId) }, { headers });
    }
    const row = await repository.requireRemoteConnection(env, org(env), user.id, body.connectionId || '');
    if (body.action === 'connect') return json({ connection: publicRow(row), ...await startConnection(env, row, target, requestId, body.conversationId) }, { headers });
    if (body.action === 'test') {
      try {
        const tools = await useConnection(env, row, rpc => listRemoteTools(rpc));
        await repository.recordRemoteTest(env, row, target, tools.length, null);
        return json({ connection: publicRow(row), tested: true, tools: await advertisedTools(tools, row,
          await repository.remoteBindingApproval(env, row.id, target)) }, { headers });
      } catch (error) {
        const code = error instanceof HttpError ? error.code : 'remote_mcp_test_failed';
        await repository.recordRemoteTest(env, row, target, 0, code);
        throw error;
      }
    }
    if (!['enable', 'disable', 'remove'].includes(body.action || '')) throw new HttpError(400, 'remote_mcp_management_action_invalid');
    if (body.approved !== true) throw new HttpError(403, 'remote_mcp_approval_required');
    if (row.generation !== body.generation) throw new HttpError(409, 'remote_mcp_connection_changed');
    if (body.action === 'remove') {
      await repository.removeRemoteInstallation(env, row, target);
    } else if (body.action === 'disable') {
      await env.AUTH_DB.prepare('DELETE FROM auth_remote_mcp_bindings WHERE connection_id = ? AND mate_id = ?').bind(row.id, target).run();
    } else {
      if (!Array.isArray(body.tools) || !body.tools.length || body.tools.length > 64) throw new HttpError(400, 'remote_mcp_binding_invalid');
      const live = await useConnection(env, row, rpc => listRemoteTools(rpc));
      const approved: Record<string, Approval> = Object.create(null);
      for (const choice of body.tools) {
        const tool = live.find(tool => tool.name === choice.name);
        if (!tool || await toolDigest(tool) !== choice.digest || typeof choice.readOnly !== 'boolean' || Object.hasOwn(approved, choice.name))
          throw new HttpError(409, 'remote_mcp_tool_changed');
        approved[choice.name] = { digest: choice.digest, readOnly: choice.readOnly };
      }
      const saved = await repository.saveRemoteBinding(env, row, target, JSON.stringify(approved), true);
      if (!saved[0].meta.changes) throw new HttpError(409, 'remote_mcp_connection_changed');
    }
    await audit(env, row, `remote_mcp_plugin_${body.action}`, requestId, { mateId: target });
    return json({ completed: true, action: body.action }, { headers });
  }
  if (path === '/v1/internal/remote-mcp/tools') {
    const rows = await repository.listRemoteConnections(env, org(env), user.id, target);
    const connections = await Promise.all((rows.results || []).filter(row => row.status === 'connected').map(async row => {
      try {
        const tools = await useConnection(env, row, async (rpc, current) => (await advertisedTools(await listRemoteTools(rpc), current, await repository.remoteBindingApproval(env, row.id, target))).filter(tool => tool.enabled));
        return { ...publicRow(row), tools };
      } catch { return { ...publicRow(row), tools: [], unavailable: true }; }
    }));
    return json({ connections }, { headers });
  }
  if (path !== '/v1/internal/remote-mcp/call') throw new HttpError(404, 'remote_mcp_route_not_found');
  const initial = await repository.requireRemoteConnection(env, org(env), user.id, body.connectionId || '');
  if (initial.generation !== body.generation || !await repository.remoteBindingExists(env, initial.id, target))
    throw new HttpError(403, 'remote_mcp_binding_required');
  if (!body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments)
    || JSON.stringify(body.arguments).length > 256_000) throw new HttpError(400, 'remote_mcp_arguments_invalid');
  const result = await useConnection(env, initial, async (rpc, row) => {
    const tools = await advertisedTools(await listRemoteTools(rpc), row, await repository.remoteBindingApproval(env, row.id, target));
    const selected = tools.find(tool => tool.name === body.toolName && tool.enabled && tool.digest === body.digest);
    if (!selected) throw new HttpError(409, 'remote_mcp_tool_changed');
    if (!selected.readOnly && body.approved !== true) throw new HttpError(403, 'remote_mcp_approval_required');
    if (!await repository.remoteBindingExists(env, row.id, target)) throw new HttpError(403, 'remote_mcp_binding_required');
    await audit(env, row, 'remote_mcp_tool_called', requestId, { mateId: target, toolName: selected.name });
    return rpc('tools/call', { name: selected.name, arguments: body.arguments });
  });
  return json({ result }, { headers });
}

async function startConnection(env: Env, row: repository.RemoteConnection, target: string, requestId: string, conversationId?: string) {
  if (row.status === 'connected') return { connected: true };
  const pending = await repository.beginRemoteConnect(env, row);
  if (!pending) throw new HttpError(409, 'remote_mcp_connection_changed');
  try {
    try {
      await withRemoteMcp(env, row.server_url, undefined, listRemoteTools);
      const credential: RemoteCredential = { expiresAt: 8640000000000000 };
      const saved = await repository.finishRemoteConnect(env, pending, await sealCredential(env, owner(row), credential), credential.expiresAt);
      if (!saved.meta.changes) throw new HttpError(409, 'remote_mcp_connection_changed');
      await audit(env, row, 'remote_mcp_connected', requestId);
      return { connected: true };
    } catch (error) {
      if (!(error instanceof RemoteAuthorizationRequired)) throw error;
      const context = await discoverRemoteOAuth(env, row.server_url, error.challenge);
      context.mateId = target;
      if (conversationId && /^[\w-]{1,160}$/.test(conversationId)) context.conversationId = conversationId;
      const saved = await repository.saveRemoteState(env, pending, await sha256(context.state), await sealCredential(env, owner(row), context));
      if (!saved[1].meta.changes) throw new HttpError(409, 'remote_mcp_connection_changed');
      await audit(env, row, 'remote_mcp_connect_started', requestId);
      return { authorizationUrl: await remoteAuthorizationUrl(context), authorizationRequired: true };
    }
  } catch (error) { await repository.cancelRemoteConnect(env, pending); throw error; }
}
