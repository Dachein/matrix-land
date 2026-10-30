import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.ts';
import { TestD1, TestR2 } from '../../../../tests/integrations/fixtures.mjs';
function fixture(t) {
  const env = { KNOWLEDGE_DB: new TestD1('workers/knowledge/db/schema.sql'), KNOWLEDGE_OBJECTS: new TestR2(), DEV_AUTH_BYPASS: '1', KNOWLEDGE_ORG_ID: 'org',
    KNOWLEDGE_V2_MUTATION_SPINE_ENABLED: '1', KNOWLEDGE_V2_ROOT_ACL_ENABLED: '1', KNOWLEDGE_AUDIO_DOWNLOAD_HOSTS: 'audio.plaud.test' };
  t.after(() => env.KNOWLEDGE_DB.database.close()); return env;
}
async function req(env, path, body, user = 'alice', key = 'test-audio') {
  return worker.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'x-workspace-user-id': user, 'x-workspace-user-email': `${user}@test`, 'x-workspace-role': 'member',
    'Idempotency-Key': key, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body instanceof FormData ? body : JSON.stringify(body) }), env);
}
function audio(parent, url = 'https://audio.plaud.test/recording?signature=private') {
  const form = new FormData(); form.set('sourceUrl', url); form.set('fileName', 'original.m4a'); form.set('mimeType', 'audio/mp4'); form.set('parentObjectId', parent); return form;
}
test('streams audio to selected authorized folder, records a real immutable version and replays without downloading again', async t => {
  const env = fixture(t); let calls = 0;
  const bytes = new Uint8Array(6 * 1024 * 1024 + 100).fill(45);
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls++; assert.equal(init.redirect, 'error'); return new Response(bytes, { headers: { 'Content-Type': 'audio/mp4' } }); });
  const root = (await (await req(env, '/api/folders', { name: 'Research meetings' }, 'alice', 'folder')).json()).item.id;
  const response = await req(env, '/api/files/upload', audio(root)); assert.equal(response.status, 201, await response.clone().text());
  const payload = await response.json(); assert.equal(payload.item.path, 'Research meetings/original.m4a'); assert.equal(payload.version.sizeBytes, bytes.length);
  assert.equal(env.KNOWLEDGE_OBJECTS.uploads[0].length, 2);
  assert.equal((await req(env, '/api/files/upload', audio(root))).status, 201); assert.equal(calls, 1);
  assert.equal((await req(env, '/api/files/upload', audio(root), 'bob')).status, 403); assert.equal(calls, 1);
  assert.equal((await req(env, '/api/files/upload', audio(root, 'https://audio.plaud.test/different'))).status, 409);
  const saved = JSON.stringify(env.KNOWLEDGE_DB.database.prepare('SELECT * FROM knowledge_objects').all()); assert.ok(!saved.includes('signature=private'));
});
test('denies unsafe download hosts and rejects oversize/failed bodies without keeping empty objects', async t => {
  const env = fixture(t); const root = (await (await req(env, '/api/folders', { name: 'Archive' }, 'alice', 'folder')).json()).item.id;
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(new Uint8Array(101), { headers: { 'Content-Type': 'audio/mp4' } }); });
  assert.equal((await req(env, '/api/files/upload', audio(root, 'http://127.0.0.1/private'))).status, 502); assert.equal(calls, 0);
  env.KNOWLEDGE_MAX_AUDIO_FILE_BYTES = '100';
  assert.equal((await req(env, '/api/files/upload', audio(root))).status, 413); assert.equal(env.KNOWLEDGE_OBJECTS.aborted, 1);
  assert.equal(env.KNOWLEDGE_DB.database.prepare("SELECT COUNT(*) AS n FROM knowledge_objects WHERE object_kind='file'").get().n, 0);
});
test('streamed binary cannot bypass scanning by its filename, and quota failure compensates storage', async t => {
  const env = fixture(t); t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(20).fill(42), { headers: { 'Content-Type': 'audio/mp4' } }));
  const root = (await (await req(env, '/api/folders', { name: 'Scan checks' }, 'alice', 'folder')).json()).item.id;
  const renamed = audio(root); renamed.set('fileName', 'recording.md');
  const saved = await req(env, '/api/files/upload', renamed, 'alice', 'scan-check'); assert.equal(saved.status, 201);
  const item = (await saved.json()).item;
  assert.equal(env.KNOWLEDGE_DB.database.prepare('SELECT scan_status FROM knowledge_ingestion_states WHERE object_id=?').get(item.id).scan_status, 'pending');
  env.KNOWLEDGE_DB.database.exec('UPDATE knowledge_namespaces SET quota_bytes=21');
  const rejected = await req(env, '/api/files/upload', audio(root), 'alice', 'quota-check'); assert.equal(rejected.status, 413);
  assert.equal(env.KNOWLEDGE_OBJECTS.objects.size, 1);
  assert.equal(env.KNOWLEDGE_DB.database.prepare("SELECT COUNT(*) AS n FROM knowledge_objects WHERE object_kind='file'").get().n, 1);
});
