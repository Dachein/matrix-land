import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
const root = fileURLToPath(new URL('../', import.meta.url));
const directories = ['.github','apps','config','connectors','db','docs','functions','packages','public','schemas','scripts','sdk','services','src','tests','tools','workers'];
const files = ['.gitignore','CONTRIBUTING.md','LICENSE','README.md','SECURITY.md','package.json','package-lock.json','tsconfig.json','vite.config.ts'];
const excludedDirectories = new Set(['node_modules','dist','.build','.wrangler','.workspace','.git','test-results','playwright-report','__pycache__']);
function excludedFile(name) {
 return name === '.DS_Store' || name === '.env' || name === '.dev.vars' || name.startsWith('.env.') && name !== '.env.example'
  || /(?:\.log|\.local|\.pem|\.key|\.pyc|\.secrets\.json|-plan\.json)$/.test(name)
  || ['installation.json','project.private.config.json'].includes(name);
}
async function collect(path) {
 for (const entry of await readdir(resolve(root,path), {withFileTypes:true})) {
  if (entry.isSymbolicLink() || excludedDirectories.has(entry.name) || excludedFile(entry.name)) continue;
  const child = `${path}/${entry.name}`;
  if (entry.isDirectory()) await collect(child); else files.push(child);
 }
}
for (const directory of directories) await collect(directory);
for (const entry of await readdir(root)) if (/^playwright.*\.config\.ts$/.test(entry)) files.push(entry);
const {version} = JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
const prefix = `matrix-land-${version}`;
const entries = {};
const contentHash = createHash('sha256');
for (const path of files.sort()) {
 const content = await readFile(resolve(root,path));
 entries[`${prefix}/${path}`] = [new Uint8Array(content), {mtime:new Date('2000-01-01T00:00:00Z')}];
 contentHash.update(path).update(content);
}
const archive = zipSync(entries, {level:6});
await mkdir(resolve(root,'release'), {recursive:true});
const name = `${prefix}-candidate.zip`;
await writeFile(resolve(root,'release',name),archive);
const sha256=createHash('sha256').update(archive).digest('hex');
const manifest={product:'Matrix land',version,stage:'candidate',archive:name,sha256,sourceContentSha256:contentHash.digest('hex'),fileCount:files.length,cloudAcceptance:'pending',excluded:['local credentials and instance state','build output and dependencies','Git history','marketing website and its deployment account']};
await writeFile(resolve(root,'release/candidate.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(resolve(root,'release/CANDIDATE-SHA256SUMS'),`${sha256}  ${name}\n`);
console.log(JSON.stringify({archive:resolve(root,'release',name),...manifest},null,2));
