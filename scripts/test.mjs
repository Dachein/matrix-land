import { readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const group = process.argv[2] ?? 'all';
const roots = group === 'portal' ? ['apps/portal', 'src/portal']
  : group === 'api' ? ['functions', 'workers']
  : ['apps/portal', 'apps/mate-preview', 'functions', 'workers', 'src', 'sdk', 'packages', 'connectors', 'tools', 'scripts', 'tests'];
const tests = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ['node_modules', 'dist', '.wrangler', '.build'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.name.endsWith('.test.mjs')) tests.push(relative(root, path));
  }
}
for (const directory of roots) visit(resolve(root, directory));
if (!tests.length) throw new Error('No tests selected');
console.log(`Running ${tests.length} test files (${group}).`);
const result = spawnSync(process.execPath, [
  '--test', '--test-force-exit', '--test-concurrency=4', '--experimental-strip-types',
  ...tests.sort()
], { cwd: root, stdio: 'inherit', env: { ...process.env, WORKSPACE_TEST: '1' } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
