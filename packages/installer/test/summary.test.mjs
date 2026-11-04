import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {saveSummary,installationBackup,readInstallationSummary} from '../src/summary.mjs';
import {atomicJson,seal,unseal} from '../src/state.mjs';

const plan={installationId:'summary-lab',release:'0.1.0',config:{brand:{name:'Matrix land'},domains:{portalHostname:'play.matrixland.si'},cloudflare:{accountId:'account',zoneId:'zone'},identity:{ownerEmail:'owner@example.test'},modules:['knowledge']}};
test('summary persists incomplete and deployed outcomes without declaring business acceptance complete',async t=>{
 const root=await mkdtemp(resolve(tmpdir(),'installer-summary-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const failed=await saveSummary(root,plan,{ok:false,error:'missing_secret_reference:env:CF_TOKEN'},[{step:'preflight',status:'failed'}]);
 assert.equal(failed.status,'incomplete');assert.equal(failed.acceptance.status,'pending');
 const done=await saveSummary(root,plan,{ok:true,acceptance:{status:'pending'}},[{step:'verify',status:'succeeded'}]);
 assert.equal(done.status,'deployed');assert.equal(done.acceptance.status,'pending');
 assert.deepEqual(JSON.parse(await readFile(resolve(root,'.workspace/summary-lab/summary.json'),'utf8')),done);
});
test('installation backup preserves encrypted credentials and excludes vault password',async t=>{
 const root=await mkdtemp(resolve(tmpdir(),'installer-backup-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dir=resolve(root,'.workspace',plan.installationId),password='separate-vault-password',secret='synthetic-cloudflare-token';
 await atomicJson(resolve(dir,'installation.json'),plan.config);
 await atomicJson(resolve(dir,'state.json'),{resources:{}});
 await atomicJson(resolve(dir,'vault.json'),seal({INSTALLER_CREDENTIALS:{CF_TOKEN:secret}},password));
 await saveSummary(root,plan,{ok:true},[]);
 const backup=await installationBackup(root,plan);
 assert(!JSON.stringify(backup).includes(secret));assert(!JSON.stringify(backup).includes(password));
 assert.equal(unseal(backup.files['vault.json'],password).INSTALLER_CREDENTIALS.CF_TOKEN,secret);
 assert.equal(Object.keys(backup.files).length,4);
 const saved=await readInstallationSummary(root,plan.installationId);
 assert.equal(saved.config.identity.ownerEmail,plan.config.identity.ownerEmail);
 assert.equal(saved.summary.status,'deployed');
 assert(!JSON.stringify(saved).includes(secret));
 await assert.rejects(readInstallationSummary(root,'../another-installation'),/invalid_installation_id/);
});
test('incomplete installation cannot export an apparently usable backup',async t=>{
 const root=await mkdtemp(resolve(tmpdir(),'installer-backup-missing-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await saveSummary(root,plan,{ok:false,error:'preflight_failed'},[]);
 await assert.rejects(installationBackup(root,plan),/installation_backup_not_ready/);
});
