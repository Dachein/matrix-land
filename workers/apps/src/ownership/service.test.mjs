import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { it } from 'node:test';
import { build } from 'esbuild';

const dir = await mkdtemp(join(tmpdir(), 'ownership-tests-'));
async function bundle(file, name) {
  const outfile = join(dir, name + '.mjs');
  await build({ bundle: true, entryPoints: [file], outfile, format: 'esm', platform: 'neutral', logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}
const appRepository = await bundle('workers/auth/src/repositories/apps.ts', 'app-repository');
const resourceRepository = await bundle('workers/auth/src/repositories/resources.ts', 'resource-repository');
const worker = await bundle('workers/apps/src/worker.ts', 'worker');
const service = await bundle('workers/apps/src/ownership/service.ts', 'service');
const auth = await bundle('workers/auth/src/apps/ownership.ts', 'auth');
await rm(dir, { recursive: true });

class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const db = this.db;
    const statement = params => ({ bind: (...p) => statement(p), first: async () => db.prepare(sql).get(...params) || null, all: async () => ({ results: db.prepare(sql).all(...params) }), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } }) });
    return statement([]);
  }
  async batch(statements) {
    if (this.beforeBatch) { const fn = this.beforeBatch; this.beforeBatch = undefined; fn(); }
    this.db.exec('BEGIN');
    try { const result = []; for (const s of statements) result.push(await s.run()); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
const principal = (sub = 'owner', rest = {}) => ({ sub, orgId: 'org', orgSlug: 'org', scopes: ['apps:apps:read', 'apps:apps:write'], email: sub + '@example.com', ...rest });
const admin = principal('admin', { platformRole: 'admin', tokenType: 'apps_access', scopes: ['apps:ownership:admin'] });
function fixture(type = 'app') {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync('workers/apps/db/schema.sql', 'utf8'));
  if (type === 'app') db.prepare(`INSERT INTO apps_apps (id,org_id,org_slug,owner_user_id,name,code,slug,type,status,visibility,data_service_id,created_at,updated_at,collaborator_user_ids_json) VALUES ('asset','org','org','owner','Academy','academy','academy','web','published','private','data','2026-01-01','2026-01-01','["target","collaborator"]')`).run();
  else db.prepare(`INSERT INTO apps_skills (id,org_id,org_slug,owner_user_id,name,slug,kind,status,visibility,created_at,updated_at,collaborator_user_ids_json) VALUES ('asset','org','org','owner','Skill','skill','vanilla','private','org','2026-01-01','2026-01-01','["target","collaborator"]')`).run();
  const adb = new DatabaseSync(':memory:'); adb.exec(readFileSync('workers/auth/db/schema.sql','utf8'));
  adb.exec(`INSERT INTO auth_users (id,email,name,status) VALUES ('owner','owner@example.com','Owner','active'),('target','target@example.com','Target','active'),('next','next@example.com','Next','active'),('inactive','inactive@example.com','Inactive','inactive'); INSERT INTO auth_app_clients (id,name,status,access_mode,business_owner_user_id) VALUES ('asset','Academy','listed','targeted','owner'); INSERT INTO auth_resource_clients (id,name,status,business_owner_user_id) VALUES ('app-mcp:asset','Academy','listed','owner');`);
  const aenv = { AUTH_DB: new D1(adb), WORKSPACE_ORG_ID: 'org', APPS_AUTH_SERVICE_TOKEN: 'test-service' };
  const env = { APPS_BASE_DOMAIN: "example.test", PLATFORM_MCP_URL: "https://apps.example.test/mcp", APPS_DB: new D1(db), AUTH_WORKER_URL: 'https://auth.test', APPS_AUTH_SERVICE_TOKEN: 'test-service', AUTH_SERVICE: { fetch: async req => {
    if (env.failSync && new URL(req.url).pathname.endsWith('ownership-sync')) return new Response('failed', { status: 503 });
    try { return await auth.handleAppsOwnershipRequest(req, aenv, 'req'); } catch (e) { return Response.json({ error: e.code }, { status: e.status || 500 }); }
  } } };
  return { env, db, adb, aenv, row: () => db.prepare(`SELECT * FROM apps_${type}s WHERE id='asset'`).get() };
}
const fails = (promise, code) => assert.rejects(promise, e => e.code === code);

for (const type of ['app', 'skill']) {
  it(`${type}: owner requests, recipient accepts once, promotes collaborator and retains previous owner`, async () => {
    const f = fixture(type);
    const r = await service.initiateOwnerTransfer(f.env, principal(), type, 'asset', { toUserId: 'target' });
    assert.equal(f.row().owner_user_id, 'owner');
    assert.equal((await service.listOwnerTransfers(f.env, principal('target')))[0].id, r.transfer.id);
    const result = await service.decideOwnerTransfer(f.env, principal('target'), r.transfer.id, 'accept');
    assert.equal(result.syncPending, false); assert.equal(f.row().owner_user_id, 'target');
    assert.deepEqual(JSON.parse(f.row().collaborator_user_ids_json), ['collaborator', 'owner']);
    assert.equal(f.row().visibility, type === 'app' ? 'private' : 'org');
    await service.decideOwnerTransfer(f.env, principal('target'), r.transfer.id, 'accept');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM apps_audit_logs WHERE action='apps.owner_transfer.accept'").get().n, 1);
    await fails(service.decideOwnerTransfer(f.env, principal('owner'), r.transfer.id, 'cancel'), 'apps_owner_transfer_not_pending');
    if (type === 'app') {
      for (const table of ['auth_app_clients', 'auth_resource_clients']) {
        const a = f.adb.prepare(`SELECT * FROM ${table}`).get();
        assert.equal(a.business_owner_user_id, 'target'); assert.equal(a.publisher_user_id, 'target');
        assert.deepEqual(JSON.parse(a.collaborator_user_ids_json), ['collaborator', 'owner']);
      }
    }
  });
  it(`${type}: admin can transfer a non-owned resource and remove previous Owner`, async () => {
    const f = fixture(type);
    const pending = await service.initiateOwnerTransfer(f.env, principal(), type, 'asset', { toUserId: 'target' });
    const result = await service.initiateOwnerTransfer(f.env, admin, type, 'asset', { toUserId: 'next', reason: 'Team handover', retainPreviousOwner: false }, true);
    assert.equal(result.transfer.status, 'admin_forced'); assert.equal(f.row().owner_user_id, 'next');
    assert.ok(!JSON.parse(f.row().collaborator_user_ids_json).includes('owner'));
    assert.equal(f.db.prepare('SELECT status FROM apps_owner_transfers WHERE id=?').get(pending.transfer.id).status, 'cancelled');
    await fails(service.decideOwnerTransfer(f.env, principal('target'), pending.transfer.id, 'accept'), 'apps_owner_transfer_not_pending');
  });
}

it('denies collaborator transfer, forged admin scope, cross-organization access and inactive or same owner targets', async () => {
  const f = fixture();
  await fails(service.initiateOwnerTransfer(f.env, principal('collaborator'), 'app', 'asset', { toUserId: 'target' }), 'apps_owner_transfer_denied');
  await fails(service.initiateOwnerTransfer(f.env, principal('collaborator', { scopes: ['apps:apps:admin', 'apps:ownership:admin'] }), 'app', 'asset', { toUserId: 'target', reason: 'x' }, true), 'apps_ownership_admin_required');
  await fails(service.listOwnershipAssets(f.env, principal()), 'apps_ownership_admin_required');
  await fails(service.initiateOwnerTransfer(f.env, principal('owner', { orgId: 'other' }), 'app', 'asset', { toUserId: 'target' }), 'apps_ownership_asset_not_found');
  await fails(service.initiateOwnerTransfer(f.env, principal(), 'app', 'asset', { toUserId: 'inactive' }), 'apps_owner_target_inactive');
  await fails(service.initiateOwnerTransfer(f.env, principal(), 'app', 'asset', { toUserId: 'owner@example.com' }), 'apps_owner_transfer_same_user');
  await fails(service.initiateOwnerTransfer(f.env, admin, 'app', 'asset', { toUserId: 'target' }, true), 'apps_owner_transfer_reason_required');
  assert.equal(f.row().owner_user_id, 'owner');
});

it('rejects replay, cancellation after acceptance, expired requests and decisions by non-recipients', async () => {
  const f = fixture();
  const { transfer } = await service.initiateOwnerTransfer(f.env, principal(), 'app', 'asset', { toUserId: 'target' });
  await fails(service.initiateOwnerTransfer(f.env, principal(), 'app', 'asset', { toUserId: 'next' }), 'apps_owner_transfer_already_pending');
  await fails(service.decideOwnerTransfer(f.env, principal('collaborator'), transfer.id, 'accept'), 'apps_owner_transfer_denied');
  await service.decideOwnerTransfer(f.env, principal('target'), transfer.id, 'reject');
  await fails(service.decideOwnerTransfer(f.env, principal('target'), transfer.id, 'accept'), 'apps_owner_transfer_not_pending');
  const next = await service.initiateOwnerTransfer(f.env, principal(), 'app', 'asset', { toUserId: 'target' });
  f.db.prepare("UPDATE apps_owner_transfers SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(next.transfer.id);
  await fails(service.decideOwnerTransfer(f.env, principal('target'), next.transfer.id, 'accept'), 'apps_owner_transfer_expired');
  assert.equal(f.row().owner_user_id, 'owner');
});

it('a concurrent rejection atomically prevents every ownership and audit change', async () => {
  const f = fixture();
  const { transfer } = await service.initiateOwnerTransfer(f.env, principal(), 'app', 'asset', { toUserId: 'target' });
  f.env.APPS_DB.beforeBatch = () => f.db.prepare("UPDATE apps_owner_transfers SET status='rejected' WHERE id=?").run(transfer.id);
  await fails(service.decideOwnerTransfer(f.env, principal('target'), transfer.id, 'accept'), 'apps_owner_transfer_owner_changed');
  assert.equal(f.row().owner_user_id, 'owner');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM apps_audit_logs WHERE action='apps.owner_transfer.accept'").get().n, 0);
});

it('an administrator with a stale snapshot cannot cancel requests or leave a misleading audit record', async () => {
  const f = fixture();
  const { transfer } = await service.initiateOwnerTransfer(f.env, principal(), 'app', 'asset', { toUserId: 'target' });
  f.env.APPS_DB.beforeBatch = () => f.db.prepare("UPDATE apps_apps SET updated_at='changed' WHERE id='asset'").run();
  await fails(service.initiateOwnerTransfer(f.env, admin, 'app', 'asset', { toUserId: 'next', reason: 'Handover' }, true), 'apps_owner_transfer_owner_changed');
  assert.equal(f.db.prepare('SELECT status FROM apps_owner_transfers WHERE id=?').get(transfer.id).status, 'pending');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM apps_audit_logs WHERE action='apps.owner_transfer.admin_force'").get().n, 0);
});

it('persists sync failure, prevents another handover, and retries without republishing', async () => {
  const f = fixture(); f.env.failSync = true;
  const { transfer } = await service.initiateOwnerTransfer(f.env, principal(), 'app', 'asset', { toUserId: 'target', retainPreviousOwner: false });
  const result = await service.decideOwnerTransfer(f.env, principal('target'), transfer.id, 'accept');
  assert.equal(result.syncPending, true); assert.equal(f.row().ownership_sync_pending, 1);
  await fails(service.initiateOwnerTransfer(f.env, principal('target'), 'app', 'asset', { toUserId: 'next' }), 'apps_ownership_sync_pending');
  f.env.failSync = false; await service.retryPendingOwnership(f.env);
  assert.equal(f.row().ownership_sync_pending, 0);
  assert.equal(f.adb.prepare('SELECT business_owner_user_id,status FROM auth_app_clients').get().status, 'listed');
  assert.equal(f.adb.prepare('SELECT business_owner_user_id FROM auth_resource_clients').get().business_owner_user_id, 'target');
});

it('the internal identity and projection APIs reject wrong service tokens and organizations', async () => {
  const f = fixture();
  const req = (token, orgId) => new Request('https://auth.test/v1/internal/apps/owner-identity', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ orgId, userId: 'target' }) });
  await fails(auth.handleAppsOwnershipRequest(req('wrong', 'org'), f.aenv, 'req'), 'invalid_service_token');
  await fails(auth.handleAppsOwnershipRequest(req('test-service', 'other'), f.aenv, 'req'), 'organization_mismatch');
});

it('migrates existing resources without changing owners or data', () => {
  const db = new DatabaseSync(':memory:');
  const schema = readFileSync('workers/apps/db/schema.sql', 'utf8').split('CREATE TABLE IF NOT EXISTS apps_owner_transfers')[0].replaceAll('  ownership_sync_pending INTEGER NOT NULL DEFAULT 0,\n','').replaceAll('  ownership_sync_lock_until TEXT,\n','');
  db.exec(schema);
  db.exec(readFileSync('workers/apps/db/d1-migrations/0021_owner_transfers.sql','utf8'));
  assert.ok(db.prepare('PRAGMA table_info(apps_apps)').all().some(c => c.name === 'ownership_sync_pending'));
  assert.ok(db.prepare('PRAGMA table_info(apps_skills)').all().some(c => c.name === 'ownership_sync_pending'));
});

it('delayed builder registrations cannot restore old ownership or collaborator privileges', async () => {
  const f = fixture();
  await service.initiateOwnerTransfer(f.env, admin, 'app', 'asset', { toUserId: 'target', reason: 'Handover', retainPreviousOwner: false }, true);
  await appRepository.registerAppClient(f.aenv, { id: 'asset', appSecret: 'x'.repeat(32), businessOwnerUserId: 'owner', publisherUserId: 'owner', collaboratorUserIds: ['owner'], systemRolePolicyVersion: '2020-01-01', accessTargets: ['user:owner'] });
  await resourceRepository.registerResourceClient(f.aenv, { id: 'app-mcp:asset', businessOwnerUserId: 'owner', publisherUserId: 'owner', collaboratorUserIds: ['owner'], systemRolePolicyVersion: '2020-01-01', accessTargets: ['user:owner'] });
  for (const table of ['auth_app_clients','auth_resource_clients']) {
    const row = f.adb.prepare(`SELECT * FROM ${table}`).get();
    assert.equal(row.business_owner_user_id, 'target');
    assert.deepEqual(JSON.parse(row.collaborator_user_ids_json), ['collaborator']);
    assert.ok(!JSON.parse(row.access_targets_json).includes('user:owner'));
  }
});

it('routes a signed owner request and denies an untrusted admin header', async () => {
  const { createHmac } = await import('node:crypto');
  const f = fixture(); f.env.APPS_JWT_SECRET = 'test-signing-secret';
  function request(path, who, body, extras = {}) {
    const payload = Buffer.from(JSON.stringify({ sub: who.sub, email: who.email, org_id: who.orgId, org_slug: who.orgSlug, scopes: who.scopes, typ: who.tokenType || 'apps_access', platform_role: who.platformRole, exp: Math.floor(Date.now()/1000)+60 })).toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url');
    const unsigned = header+'.'+payload;
    const token = unsigned+'.'+createHmac('sha256', f.env.APPS_JWT_SECRET).update(unsigned).digest('base64url');
    return new Request('https://apps.test'+path, { method: body ? 'POST' : 'GET', headers:{ authorization:'Bearer '+token,'content-type':'application/json',...extras }, body:body ? JSON.stringify(body) : undefined });
  }
  const ctx = { waitUntil() {} };
  let response = await worker.handleAppsWorkerRequest(request('/apps/asset/owner-transfer', principal(), { toUserId:'target' }), f.env, ctx);
  assert.equal(response.status,200); const { transfer } = await response.json();
  response = await worker.handleAppsWorkerRequest(request('/owner-transfers/'+transfer.id+'/accept', principal('target'), {}), f.env, ctx);
  assert.equal(response.status,200); assert.equal(f.row().owner_user_id,'target');
  response = await worker.handleAppsWorkerRequest(request('/admin/ownership', principal(), undefined, { 'x-platform-role':'admin' }), f.env, ctx);
  assert.equal(response.status,403);
  response = await worker.handleAppsWorkerRequest(request('/admin/ownership', admin), f.env, ctx);
  assert.equal(response.status,200); assert.equal((await response.json()).assets[0].ownerUserId,'target');
});

it('removes the former Owner’s email aliases when retention is disabled, including departed users', async () => {
  const f = fixture();
  f.db.exec(`UPDATE apps_apps SET collaborator_user_ids_json='["owner@example.com","target","collaborator"]' WHERE id='asset'`);
  f.adb.exec("UPDATE auth_users SET status='inactive' WHERE id='owner'");
  await service.initiateOwnerTransfer(f.env, admin, 'app', 'asset', { toUserId:'target', reason:'Departed employee', retainPreviousOwner:false }, true);
  assert.deepEqual(JSON.parse(f.row().collaborator_user_ids_json),['collaborator']);
  assert.deepEqual(JSON.parse(f.adb.prepare('SELECT collaborator_user_ids_json FROM auth_app_clients').get().collaborator_user_ids_json),['collaborator']);
});

it('preserves author-only preview access when a draft App with configured launch targets changes Owner', async () => {
  const f = fixture();
  f.db.exec(`UPDATE apps_apps SET status='draft', access_targets_json='["department:wealth"]' WHERE id='asset'`);
  f.adb.exec("UPDATE auth_app_clients SET status='draft', access_mode='targeted'");
  await service.initiateOwnerTransfer(f.env, admin, 'app', 'asset', { toUserId:'target', reason:'Draft handover', retainPreviousOwner:false }, true);
  const client = f.adb.prepare('SELECT * FROM auth_app_clients').get();
  assert.equal(client.status,'draft'); assert.equal(client.access_mode,'targeted');
  assert.deepEqual(JSON.parse(client.access_targets_json),['user:collaborator']);
  assert.equal(client.business_owner_user_id,'target');
  assert.deepEqual(JSON.parse(f.row().access_targets_json),['department:wealth']);
});
