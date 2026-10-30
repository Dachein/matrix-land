import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.ts';
import { signAuthToken } from '../token.ts';
import { remoteUrl } from './network.ts';
import { withRemoteMcp, listRemoteTools } from './transport.ts';
import { TestD1 } from '../../../../tests/integrations/fixtures.mjs';

function fixture(t) {
  const db = new TestD1('workers/auth/db/schema.sql');
  db.database.exec("INSERT INTO auth_users (id,email,name,status) VALUES ('alice','alice@test','Alice','active'),('bob','bob@test','Bob','active')");
  t.after(() => db.database.close());
  return { AUTH_DB: db, AUTH_JWT_SECRET: 'test-secret', WORKSPACE_ORG_ID: 'org', AUTH_PUBLIC_URL: 'https://portal.test', PORTAL_URL: 'https://portal.test',
    APPS_CONTROL_PLANE: { fetch: async request => request.headers.get('x-workspace-runtime-user-id') === 'alice'
      ? Response.json({ owner: true, mateId: new URL(request.url).pathname.split('/')[3] }) : Response.json({ error: 'mate_not_found' }, { status: 404 }) },
    REMOTE_MCP_ENABLED: '1', REMOTE_MCP_ALLOWED_HOSTS: 'mcp.provider.test', MATE_MCP_SERVICE_TOKEN: 'runtime-service-secret',
    THIRD_PARTY_CREDENTIAL_KEY: 'test-credential-encryption-secret-more-than-32-characters' };
}
async function request(env, path, body, user = 'alice', origin = 'https://portal.test') {
  if (path === 'connections' && body === undefined) path += '?mateId=mate';
  if (body !== undefined) body = { mateId: 'mate', ...body };
  const token = await signAuthToken(env, { typ: 'workspace_session', sub: user, email: `${user}@test`, exp: Math.floor(Date.now()/1000)+300 });
  return worker.fetch(new Request(`https://auth.test/auth/remote-mcp/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: `workspace_session=${token}`, Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
}
async function internal(env, path, body, token = env.MATE_MCP_SERVICE_TOKEN) {
  return worker.fetch(new Request(`https://auth.test/v1/internal/remote-mcp/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgId: 'org', userId: 'alice', mateId: 'mate', ...body }) }), env);
}
function provider(t, { anonymous = false, sse = false } = {}) {
  const control = { tools: [{ name: 'list_files', description: 'List recordings', inputSchema: { type: 'object', properties: { page: { type: 'number' } } }, annotations: { readOnlyHint: true } },
    { name: 'remove_file', description: 'Delete recording', inputSchema: { type: 'object' } }], calls: [], refreshes: 0, verifier: '', closed: 0 };
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'mcp.provider.test'); assert.equal(init.redirect, 'manual');
    if (url.pathname.includes('oauth-protected-resource')) return Response.json({ resource: 'https://mcp.provider.test/mcp', authorization_servers: ['https://mcp.provider.test/'] });
    if (url.pathname.includes('oauth-authorization-server')) return Response.json({ issuer: 'https://mcp.provider.test/', authorization_endpoint: 'https://mcp.provider.test/authorize', token_endpoint: 'https://mcp.provider.test/token',
      registration_endpoint: 'https://mcp.provider.test/register', code_challenge_methods_supported: ['S256'], response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register') { const client = JSON.parse(init.body); assert.equal(client.token_endpoint_auth_method, 'none'); return Response.json({ ...client, client_id: 'workspace-client' }); }
    if (url.pathname === '/token') {
      const body = new URLSearchParams(init.body); assert.equal(body.get('resource'), 'https://mcp.provider.test/mcp');
      if (body.get('grant_type') === 'refresh_token') control.refreshes++; else { control.verifier = body.get('code_verifier'); assert.equal(body.get('redirect_uri'), 'https://portal.test/auth/remote-mcp/callback'); }
      return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    assert.equal(url.pathname, '/mcp');
    if (init.method === 'DELETE') { control.closed++; return new Response(null, { status: 204 }); }
    if (!anonymous && new Headers(init.headers).get('authorization') !== 'Bearer private-access') return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.provider.test/.well-known/oauth-protected-resource/mcp"' } });
    const rpc = JSON.parse(init.body);
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
    else if (rpc.method === 'tools/list') result = { tools: control.tools };
    else { assert.equal(rpc.method, 'tools/call'); control.calls.push(rpc.params); result = { content: [{ type: 'text', text: 'done' }] }; }
    const response = { jsonrpc: '2.0', id: rpc.id, result };
    if (sse) return new Response(`: ping\n\ndata: ${JSON.stringify(response)}\n\n`, { headers: { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'test-session' } });
    return Response.json(response, { headers: { 'Mcp-Session-Id': 'test-session' } });
  });
  return control;
}
async function connect(env) {
  const added = await request(env, 'connections', { name: 'Example MCP', serverUrl: 'https://mcp.provider.test/mcp' });
  assert.equal(added.status, 201); const { connection } = await added.json();
  const response = await request(env, `connections/${connection.id}/connect`, { mateId: 'mate' });
  assert.equal(response.status, 200);
  const started = await response.json();
  if (started.authorizationUrl) {
    const url = new URL(started.authorizationUrl);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('resource'), connection.serverUrl);
    const path = `callback?state=${url.searchParams.get('state')}&code=test-code`;
    assert.equal((await request(env, path, undefined, 'bob')).status, 400);
    const callback = await request(env, path);
    assert.equal(callback.status, 303); assert.ok(callback.headers.get('location').includes('mate=mate'));
    assert.equal((await request(env, path)).status, 400);
  }
  const payload = await (await request(env, `connections/${connection.id}/tools?mateId=mate`)).json();
  assert.ok(payload.tools); return { connection, tools: payload.tools };
}

test('OAuth binds active user, encrypts credentials, PKCE and resource, rejects replay and cross-user access', async t => {
  const env = fixture(t), control = provider(t, { sse: true }); const { connection, tools } = await connect(env);
  assert.ok(control.verifier.length >= 43);
  const row = env.AUTH_DB.database.prepare('SELECT * FROM auth_remote_mcp_connections').get();
  assert.equal(row.status, 'connected'); assert.ok(!row.credential_ciphertext.includes('private-access'));
  const serialized = await (await request(env, 'connections')).text(); assert.ok(!serialized.includes('private-access') && !serialized.includes('ciphertext'));
  assert.equal((await request(env, `connections/${connection.id}/tools?mateId=mate`, undefined, 'bob')).status, 404);
  assert.equal((await internal(env, 'tools', {}, 'wrong')).status, 401);
  assert.equal((await internal(env, 'tools', { userId: 'bob' })).status, 403);
  assert.equal((await request(env, `connections/${connection.id}/binding`, { mateId: 'mate', enabled: true, tools: [{ ...tools[0], readOnly: true }] })).status, 200);
  const data = await (await internal(env, 'tools', {})).json(); assert.equal(data.connections[0].tools.length, 1);
  env.AUTH_DB.database.exec("UPDATE auth_users SET status='inactive' WHERE id='alice'");
  assert.equal((await internal(env, 'tools', {})).status, 403);
});

test('only the current Mate owner can install, authorize or manage plugins; removal isolates Mates and clears last credentials', async t => {
  const env = fixture(t); provider(t, { anonymous: true });
  assert.equal((await request(env, 'connections', { name: 'Example MCP', serverUrl: 'https://mcp.provider.test/mcp' }, 'bob')).status, 403);
  assert.equal((await internal(env, 'manage', { userId: 'bob', action: 'install', name: 'Example MCP', serverUrl: 'https://mcp.provider.test/mcp' })).status, 403);
  assert.equal((await internal(env, 'manage', { action: 'install', name: 'CLI', serverUrl: 'stdio://plaud' })).status, 400);
  const installed = await internal(env, 'manage', { action: 'install', name: 'Example MCP', serverUrl: 'https://mcp.provider.test/mcp' });
  assert.equal(installed.status, 200);
  const { connection } = await installed.json();
  const tested = await (await internal(env, 'manage', { action: 'test', connectionId: connection.id })).json();
  assert.equal(tested.tested, true);
  const operation = { action: 'enable', connectionId: connection.id, generation: tested.connection.generation,
    tools: [{ name: tested.tools[0].name, digest: tested.tools[0].digest, readOnly: true }] };
  assert.equal((await internal(env, 'manage', operation)).status, 403);
  assert.equal((await internal(env, 'manage', { ...operation, approved: true })).status, 200);
  const listing = await (await internal(env, 'manage', { action: 'list' })).json();
  assert.equal(listing.connections[0].enabledForMate, true);
  assert.ok(listing.connections[0].lastTestedAt);
  await internal(env, 'manage', { action: 'install', mateId: 'other-mate', name: 'Example MCP', serverUrl: 'https://mcp.provider.test/mcp' });
  assert.equal((await request(env, `connections/${connection.id}/remove`, {})).status, 200);
  assert.equal(env.AUTH_DB.database.prepare('SELECT COUNT(*) count FROM auth_remote_mcp_connections').get().count, 1);
  assert.equal((await internal(env, 'call', { connectionId: connection.id, generation: tested.connection.generation,
    toolName: tested.tools[0].name, digest: tested.tools[0].digest, arguments: {} })).status, 403);
  await request(env, `connections/${connection.id}/remove`, { mateId: 'other-mate' });
  assert.equal(env.AUTH_DB.database.prepare('SELECT COUNT(*) count FROM auth_remote_mcp_connections').get().count, 0);
  assert.equal(env.AUTH_DB.database.prepare('SELECT COUNT(*) count FROM auth_remote_mcp_states').get().count, 0);
});

test('ownership changes block OAuth completion and fail closed when the control plane is unavailable', async t => {
  const env = fixture(t); provider(t);
  const { connection } = await (await request(env, 'connections', { name: 'Example MCP', serverUrl: 'https://mcp.provider.test/mcp' })).json();
  const started = await (await request(env, `connections/${connection.id}/connect`, {})).json();
  env.APPS_CONTROL_PLANE = { fetch: async () => Response.json({ error: 'mate_not_found' }, { status: 404 }) };
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  const callback = await request(env, `callback?state=${state}&code=test-code`);
  assert.equal(callback.status, 303);
  assert.ok(callback.headers.get('location').includes('remoteMcp=failed'));
  assert.equal(env.AUTH_DB.database.prepare('SELECT credential_ciphertext FROM auth_remote_mcp_connections').get().credential_ciphertext, null);
  assert.equal((await request(env, 'connections')).status, 403);
  delete env.APPS_CONTROL_PLANE;
  assert.equal((await internal(env, 'manage', { action: 'list' })).status, 503);
});

test('per-Mate selected tools stay isolated, pin changes, require write approval and reject disconnected calls', async t => {
  const env = fixture(t), control = provider(t); const { connection, tools } = await connect(env);
  const bind = (mateId, selected) => request(env, `connections/${connection.id}/binding`, { mateId, enabled: true, tools: selected });
  assert.equal((await bind('mate', [{ ...tools[0], readOnly: true }, { ...tools[1], readOnly: false }])).status, 200);
  await bind('other-mate', [{ ...tools[0], readOnly: true }]);
  await request(env, `connections/${connection.id}/binding`, { mateId: 'other-mate', enabled: false });
  const catalog = await (await internal(env, 'tools', {})).json(); const c = catalog.connections[0]; assert.equal(c.tools.length, 2);
  const call = { connectionId: connection.id, generation: c.generation, toolName: tools[0].name, digest: tools[0].digest, arguments: { page: 1 } };
  assert.equal((await internal(env, 'call', call)).status, 200);
  assert.equal((await internal(env, 'call', { ...call, toolName: tools[1].name, digest: tools[1].digest })).status, 403);
  assert.equal((await internal(env, 'call', { ...call, toolName: tools[1].name, digest: tools[1].digest, approved: true })).status, 200);
  control.tools[0].description = 'Changed behavior';
  assert.equal((await internal(env, 'call', call)).status, 409);
  assert.equal((await bind('mate', [{ ...tools[0], readOnly: true }])).status, 409);
  assert.equal((await request(env, `connections/${connection.id}/disconnect`, {})).status, 200);
  assert.equal((await internal(env, 'call', call)).status, 403);
  assert.equal(control.calls.length, 2);
});

test('refresh rotation and disconnect block stale OAuth callbacks; mutations need same origin and allowed host', async t => {
  const env = fixture(t), control = provider(t); const { connection, tools } = await connect(env);
  await request(env, `connections/${connection.id}/binding`, { mateId: 'mate', enabled: true, tools: [{ ...tools[0], readOnly: true }] });
  env.AUTH_DB.database.exec('UPDATE auth_remote_mcp_connections SET credential_expires_at=1');
  assert.equal((await internal(env, 'tools', {})).status, 200); assert.equal(control.refreshes, 1);
  assert.equal((await request(env, 'connections', { name: 'bad', serverUrl: 'https://mcp.provider.test/mcp' }, 'alice', 'https://evil.test')).status, 403);
  assert.equal((await request(env, 'connections', { name: 'bad', serverUrl: 'http://localhost/mcp' })).status, 400);
  await request(env, `connections/${connection.id}/disconnect`, {});
  const started = await (await request(env, `connections/${connection.id}/connect`, {})).json();
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  await request(env, `connections/${connection.id}/disconnect`, {});
  assert.equal((await request(env, `callback?state=${state}&code=test`)).status, 400);
});

test('anonymous JSON MCP and paginated catalogs are supported, cursor loops and unsafe hosts are rejected', async t => {
  const env = fixture(t); provider(t, { anonymous: true }); const { connection } = await connect(env);
  assert.equal(connection.name, 'Example MCP');
  const result = await withRemoteMcp(env, 'https://mcp.provider.test/mcp', undefined, listRemoteTools); assert.equal(result.length, 2);
  let page = 0;
  const pages = await listRemoteTools(async () => ({ tools: [{ name: `page_${page++}`, inputSchema: { type: 'object' } }], ...(page < 3 ? { nextCursor: String(page) } : {}) }));
  assert.equal(pages.length, 3);
  await assert.rejects(listRemoteTools(async () => ({ tools: [], nextCursor: 'same' })), /cursor_invalid/);
  for (const url of ['https://127.0.0.1/mcp', 'https://mcp.provider.test:444/mcp', 'https://x@mcp.provider.test/mcp', 'https://mcp.provider.test/mcp#x']) assert.throws(() => remoteUrl(url, env));
});
