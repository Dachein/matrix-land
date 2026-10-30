import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it } from 'node:test';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'apps-artifact-cleanup-'));
const output = join(directory, 'artifacts.mjs');
await build({ entryPoints: [new URL('./artifacts.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', outfile: output, logLevel: 'silent' });
const { deleteR2ArtifactKeys } = await import(pathToFileURL(output).href);
await rm(directory, { force: true, recursive: true });

it('cleans a long App history in one storage request without deleting runtime references', async () => {
  const references = Array.from({ length: 35 }, (_, i) => `cloudflare://workers/apps-history-worker/${i}`);
  const originals = Array.from({ length: 69 }, (_, i) => `apps/history/archive-${i}.zip`);
  const calls = [];
  const result = await deleteR2ArtifactKeys({ APPS_ARTIFACTS: { async delete(keys) { calls.push(keys); } } }, [...references, ...originals, originals[0], '', null]);
  assert.deepEqual(result, originals);
  assert.deepEqual(calls, [originals]);
});

it('respects the R2 batch limit and propagates a failed batch so cleanup can be retried', async () => {
  const keys = Array.from({ length: 1001 }, (_, i) => `apps/history/${i}.zip`);
  const calls = [];
  const failure = new Error('storage unavailable');
  const env = { APPS_ARTIFACTS: { async delete(batch) { calls.push(batch); if (calls.length === 2) throw failure; } } };
  await assert.rejects(deleteR2ArtifactKeys(env, keys), error => error === failure);
  assert.deepEqual(calls.map(batch => batch.length), [1000, 1]);
  const retried = [];
  const result = await deleteR2ArtifactKeys({ APPS_ARTIFACTS: { async delete(batch) { retried.push(...batch); } } }, keys);
  assert.deepEqual(retried, keys);
  assert.deepEqual(result, keys);
});

it('does not require a storage binding when history contains only external deployment references', async () => {
  assert.deepEqual(await deleteR2ArtifactKeys({}, ['cloudflare://workers/old-worker/version']), []);
  await assert.rejects(deleteR2ArtifactKeys({}, ['apps/history/original.zip']), error => error.code === 'apps_artifacts_bucket_unavailable');
});
