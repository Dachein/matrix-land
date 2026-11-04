import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,stat,cp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {resolveConfig,validateCredentials} from '../src/config.mjs';
import {buildPlan} from '../src/plan.mjs';
import {seal,unseal,atomicJson,withLock,runSteps} from '../src/state.mjs';
import {Cloudflare} from '../src/cloudflare.mjs';
import {renderWorker} from '../src/render.mjs';
import {serveSetup} from '../src/local-server.mjs';
import {apiJson,verifyLiteLLM,initializeEntra} from '../src/integrations.mjs';
import {renderServerBundle,sshArgs} from '../src/server.mjs';
import {applyPlan} from '../src/executor.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const example=JSON.parse(await readFile(resolve(repo,'config/installation.example.json'),'utf8'));
async function fixture(t){const dir=await mkdtemp(resolve(tmpdir(),'workspace-installer-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));for(const p of ['apps','src','functions','workers','sdk','packages','public','dist'])await mkdir(resolve(dir,p));await writeFile(resolve(dir,'dist/index.html'),'<!doctype html><title>Test installation</title>');await cp(resolve(repo,'schemas'),resolve(dir,'schemas'),{recursive:true});await writeFile(resolve(dir,'package.json'),JSON.stringify({version:'0.1.0'}));await writeFile(resolve(dir,'package-lock.json'),'{}');await writeFile(resolve(dir,'vite.config.ts'),'export default {}');return dir;}
test('strict installation schema rejects secrets, ambiguous modes and unapproved owner domains',()=>{
 assert.equal(resolveConfig(example).identity.ownerEmail,'owner@example.com');
 for(const input of [{...example,apiToken:'secret'},{...example,identity:{...example.identity,ownerEmail:'someone@elsewhere.test'}},{...example,modules:['mate']},{...example,models:{mode:'disabled',baseUrl:'https://models.example.com'}}])assert.throws(()=>resolveConfig(input));
 assert.throws(()=>resolveConfig({...example,domains:{...example.domains,portalHostname:'auth.workspace.example.com'}}),/collision/);
});
test('plan selects only needed resources and fingerprints deployable source',async t=>{
 const root=await fixture(t),plan=await buildPlan(example,root);assert.deepEqual(plan.services,['auth','portal']);assert.equal(plan.resources.length,3);assert.equal(plan.steps.at(-1).id,'verify');
 await writeFile(resolve(root,'src/change.ts'),'export const release=2');assert.notEqual((await buildPlan(example,root)).id,plan.id);
 const expanded=await buildPlan({...example,modules:['knowledge','studio','operations']},root);assert(expanded.resources.some(x=>x.kind==='queue'));assert(expanded.services.includes('backup'));assert(!expanded.services.includes('mate'));
});
test('exact mailbox configuration includes the owner and reaches the authentication worker',async t=>{
 const root=await fixture(t),input={...example,identity:{...example.identity,allowedEmails:['OWNER@example.com','owner@example.com']}};
 const config=resolveConfig(input);assert.deepEqual(config.identity.allowedEmails,['owner@example.com']);
 assert.throws(()=>resolveConfig({...input,identity:{...input.identity,allowedEmails:['other@example.com']}}),/owner_email_outside_exact_allowlist/);
 assert.throws(()=>resolveConfig({...input,identity:{...input.identity,allowedEmails:[]}}));
 const plan=await buildPlan(input,root),state={resources:Object.fromEntries(plan.resources.map(r=>[`${r.kind}:${r.key}`,{name:r.name,id:`test-${r.key}`}]))};
 assert.equal(renderWorker('auth',plan,state,root).vars.AUTH_LOGIN_ALLOWED_EMAILS_JSON,'["owner@example.com"]');
 assert.equal(renderWorker('auth',await buildPlan(example,root),state,root).vars.AUTH_LOGIN_ALLOWED_EMAILS_JSON,undefined);
});

test('missing runtime credentials stop installation before creating state or calling Cloudflare',async t=>{
 const root=await fixture(t),input={...example,modules:['studio'],cloudflare:{...example.cloudflare,runtimeTokenRef:'env:WORKSPACE_RUNTIME_CF_TOKEN'}};
 const plan=await buildPlan(input,root),env={CLOUDFLARE_API_TOKEN:'private-deployment',WORKSPACE_VAULT_PASSWORD:'local-test-password-long'};
 let calls=0;
 await assert.rejects(applyPlan(plan,root,{env,fetchImpl:async()=>{calls++;throw new Error('unexpected_network');},run:async()=>{calls++;}}),/missing_secret_reference:env:WORKSPACE_RUNTIME_CF_TOKEN/);
 assert.equal(calls,0);
 await assert.rejects(stat(resolve(root,'.workspace',plan.installationId)),{code:'ENOENT'});
 assert.throws(()=>validateCredentials(resolveConfig({...input,cloudflare:example.cloudflare}),env),/runtime_token_reference_required/);
 assert.doesNotThrow(()=>validateCredentials(plan.config,{...env,WORKSPACE_RUNTIME_CF_TOKEN:'private-runtime'}));
});

test('credential validation covers model provisioning and runtime keys without exposing values',()=>{
 const config=resolveConfig({...example,modules:['mate'],cloudflare:{...example.cloudflare,runtimeTokenRef:'env:WORKSPACE_RUNTIME_CF_TOKEN'},models:{mode:'existing',baseUrl:'https://models.example.com',teamId:'test',models:['test'],maxBudget:1,provisioningSecretRef:'env:TEST_ADMIN',serviceSecretRef:'env:TEST_SERVICE'}});
 const env={CLOUDFLARE_API_TOKEN:'private-deployment',WORKSPACE_RUNTIME_CF_TOKEN:'private-runtime',TEST_ADMIN:'private-model-admin'};
 assert.throws(()=>validateCredentials(config,env),{message:'missing_secret_reference:env:TEST_SERVICE'});
 assert.doesNotThrow(()=>validateCredentials(config,{...env,TEST_SERVICE:'private-model-runtime'}));
});

test('generated service bindings and runtime Worker names belong to the selected installation',async t=>{
 const root=await fixture(t),plan=await buildPlan({...example,modules:['studio','stream','mail'],models:{mode:'existing',baseUrl:'https://models.example.com',teamId:'test',models:['test'],maxBudget:100,provisioningSecretRef:'env:TEST_ADMIN',serviceSecretRef:'env:TEST_SERVICE'}},root);
 const state={resources:Object.fromEntries(plan.resources.map(r=>[`${r.kind}:${r.key}`,{name:r.name,id:`test-${r.key}`}]))};
 const apps=renderWorker('apps',plan,state,root),mail=renderWorker('mail',plan,state,root);
 assert.equal(apps.vars.WORKSPACE_AUTH_WORKER_NAME,'example-prod-auth');
 assert.equal(apps.vars.WORKSPACE_STREAM_WORKER_NAME,'example-prod-stream');
 assert.equal(mail.vars.WORKSPACE_EMAIL_ROUTER_WORKER,mail.name);
 assert.equal(apps.services.find(s=>s.binding==='AUTH_SERVICE').service,apps.vars.WORKSPACE_AUTH_WORKER_NAME);
 assert.equal(apps.services.find(s=>s.binding==='WORKSPACE_STREAM').service,apps.vars.WORKSPACE_STREAM_WORKER_NAME);
});
test('vault uses authenticated encryption and state is private on disk',async t=>{
 const root=await fixture(t),secret={key:'sk-very-secret'},value=seal(secret,'sixteen-characters-or-more');assert(!JSON.stringify(value).includes(secret.key));assert.deepEqual(unseal(value,'sixteen-characters-or-more'),secret);assert.throws(()=>unseal(value,'different-password-long'),/vault_unlock_failed/);const corrupted={...value,data:Buffer.from('altered').toString('base64')};assert.throws(()=>unseal(corrupted,'sixteen-characters-or-more'));await atomicJson(resolve(root,'state.json'),{status:'ready'});assert.equal((await stat(resolve(root,'state.json'))).mode&0o777,0o600);
});
test('Pages uses its account environment and omits the unsupported Worker account field',async t=>{
 const root=await fixture(t),plan=await buildPlan(example,root),state={resources:Object.fromEntries(plan.resources.map(r=>[`${r.kind}:${r.key}`,{name:r.name,id:`test-${r.key}`}]))};
 const pages=renderWorker('portal',plan,state,root);
 assert.equal(Object.hasOwn(pages,'account_id'),false);
 assert.equal(pages.pages_build_output_dir,resolve(root,'dist'));
 assert.equal(pages.vars.DEFAULT_TEAM_ID,example.installationId);
 assert.equal(renderWorker('auth',plan,state,root).account_id,example.cloudflare.accountId);
});
test('installation lock excludes concurrent runs and clears after failure',async t=>{const root=await fixture(t);await withLock(root,async()=>{await assert.rejects(withLock(root,async()=>{}),/locked/);});await assert.rejects(withLock(root,async()=>{throw new Error('test-stop');}),/test-stop/);await withLock(root,async()=>{});});
test('failed step resumes without repeating successful steps or logging upstream secrets',async()=>{const plan={steps:[{id:'one'},{id:'two'}]},state={steps:{}},calls=[];let fail=true;const execute=async s=>{calls.push(s.id);if(s.id==='two'&&fail)throw new Error('sk-private-upstream');};await assert.rejects(runSteps(plan,state,async()=>{},execute));assert(!JSON.stringify(state).includes('sk-private'));fail=false;await runSteps(plan,state,async()=>{},execute);assert.deepEqual(calls,['one','two','two']);});
test('resource ownership rejects collisions and reconciles a lost create response',async()=>{let resource=null;const cf=new Cloudflare(example.cloudflare,{env:{CLOUDFLARE_API_TOKEN:'private'},fetchImpl:async(_url,options)=>{if(options.method==='POST'){resource={uuid:'db-1',name:'example-prod-core'};throw new Error('response-lost');}return Response.json({success:true,result:resource?[resource]:[]});}});const r={kind:'d1',key:'core',name:'example-prod-core'};let state;await assert.rejects(cf.ensureResource(r,undefined,async s=>{state=s;}));assert.equal((await cf.ensureResource(r,state,async()=>{})).id,'db-1');await assert.rejects(cf.ensureResource(r,undefined,async()=>{}),/not_owned/);});
test('all fresh database baselines apply, contain no enterprise rows, and enforce owner invariants',async()=>{
 for(const name of ['core','auth','apps','knowledge','mate','backup']){const db=new DatabaseSync(':memory:');for(const file of (await readdir(resolve(repo,'schemas',name))).sort())db.exec(await readFile(resolve(repo,'schemas',name,file),'utf8'));assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');if(name==='auth'){assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM auth_moka_employee_sync_exclusions').get().n,0);db.exec("INSERT INTO auth_users(id,email,name,status) VALUES('owner','owner@example.com','Owner','active'),('other','other@example.com','Other','active'); INSERT INTO workspace_bootstrap_claim VALUES(1,'hash','owner@example.com',9999999999,NULL,1); INSERT INTO workspace_ownership VALUES(1,'owner',1);");assert.equal(db.prepare("SELECT role FROM auth_users WHERE id='owner'").get().role,'admin');assert.throws(()=>db.exec("UPDATE auth_users SET role='member' WHERE id='owner'"),/transfer/);assert.throws(()=>db.exec("DELETE FROM auth_users WHERE id='owner'"),/transfer/);db.exec("UPDATE workspace_ownership SET user_id='other' WHERE id=1");assert.equal(db.prepare("SELECT role FROM auth_users WHERE id='other'").get().role,'admin');assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_ownership_audit').get().n,2);}db.close();}
});
test('local setup rejects foreign origins, host rebinding, missing session and token replay',async t=>{
 const root=await fixture(t),{server,url}=await serveSetup(root,{port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));const origin=new URL(url).origin,token=new URL(url).hash.slice(7);
 const post=(path,body,headers={})=>fetch(`${origin}/api/${path}`,{method:'POST',headers:{'content-type':'application/json',origin,...headers},body:JSON.stringify(body)});
 assert.equal((await post('session',{token},{origin:'https://attacker.test'})).status,403);assert.equal((await post('status',{})).status,403);
 const response=await post('session',{token}),cookie=response.headers.get('set-cookie').split(';')[0],{csrf}=await response.json();assert.equal(response.status,200);assert.equal((await post('session',{token})).status,403);assert.equal((await post('status',{}, {cookie,'x-setup-csrf':csrf})).status,200);assert.equal(await new Promise(resolve=>{const req=http.request(`${origin}/api/status`,{method:'POST',headers:{host:'attacker.test',origin,'content-type':'application/json',cookie,'x-setup-csrf':csrf}},res=>{res.resume();resolve(res.statusCode);});req.end('{}');}),403);
 const planResponse=await post('plan',{config:example,credentials:{CLOUDFLARE_API_TOKEN:'private-token'}},{cookie,'x-setup-csrf':csrf});assert.equal(planResponse.status,200);const reviewed=await planResponse.json();assert(!JSON.stringify(reviewed).includes('private-token'));
 const resumed=await post('session',{}, {cookie});assert.equal(resumed.status,200);const restored=await (await post('status',{}, {cookie,'x-setup-csrf':csrf})).json();assert.equal(restored.plan.id,reviewed.plan.id);assert(!JSON.stringify(restored).includes('private-token'));
});
test('integration calls never forward credentials through redirects or another origin',async()=>{let observed;await apiJson('https://models.example.com','/health/readiness','secret',{fetchImpl:async(url,init)=>{observed=init;return Response.json({db:'connected'});}});assert.equal(observed.redirect,'error');await assert.rejects(apiJson('https://models.example.com','https://other.test','secret'),/target_changed/);});
test('LiteLLM checks database, team and model scope rather than accepting a homepage',async()=>{const config={baseUrl:'https://models.example.com',models:['test-model']};const fake=async url=>Response.json(url.pathname==='/health/readiness'?{db:'connected'}:url.pathname==='/team/info'?{team_info:{team_id:'team-1'}}:url.pathname==='/key/info'?{info:{team_id:'team-1'}}:{data:[{id:'test-model'}]});assert.equal((await verifyLiteLLM(config,{token:'admin',serviceKey:'runtime',teamId:'team-1',fetchImpl:fake})).teamId,'team-1');await assert.rejects(verifyLiteLLM(config,{token:'admin',serviceKey:'runtime',teamId:'team-1',fetchImpl:async()=>Response.json({db:'not connected'})}),/database_not_ready/);});
test('install, interrupted retry and upgrade preserve data, secrets and resource IDs',async t=>{
 const root=await fixture(t),dbs=new Map(),remote={databases:[],buckets:[],pages:null,domains:[],dns:[]},calls=[],env={CLOUDFLARE_API_TOKEN:'cf-private',WORKSPACE_VAULT_PASSWORD:'local-test-password-long'},directory=resolve(root,'.workspace/example-prod');
 let lost=true;
 const fetchImpl=async(input,options={})=>{
  const u=new URL(input),path=u.pathname,method=options.method??'GET',body=options.body?JSON.parse(options.body):null;calls.push([method,path]);
  if(u.hostname!=='api.cloudflare.com')return Response.json(path==='/api/public/brand'?{brand:{name:'Example Workspace'}}:{ok:true});
  let result;
  if(path===`/client/v4/accounts/${example.cloudflare.accountId}`)result={id:example.cloudflare.accountId};
  else if(path===`/client/v4/zones/${example.cloudflare.zoneId}`)result={id:example.cloudflare.zoneId,status:'active',name:'example.com',account:{id:example.cloudflare.accountId}};
  else if(path.endsWith('/d1/database')&&method==='GET')result=remote.databases.filter(x=>x.name===u.searchParams.get('name'));
  else if(path.endsWith('/d1/database')&&method==='POST'){result={uuid:`db-${remote.databases.length}`,name:body.name};remote.databases.push(result);dbs.set(result.uuid,new DatabaseSync(':memory:'));if(lost){lost=false;throw new Error('simulated_lost_response');}}
  else if(path.endsWith('/r2/buckets')&&method==='POST'){result={name:body.name};remote.buckets.push(result);}
  else if(path.includes('/r2/buckets/')){result=remote.buckets.find(x=>x.name===path.split('/').at(-1));if(!result)return Response.json({success:false},{status:404});}
  else if(path.endsWith('/query')){const id=path.split('/').at(-2),db=dbs.get(id);const statement=db.prepare(body.sql);const results=statement.all(...body.params);result=[{success:true,results}];}
  else if(path.endsWith('/pages/projects')&&method==='POST'){remote.pages={name:body.name};result=remote.pages;}
  else if(path.endsWith('/pages/projects/example-prod-portal')){result=remote.pages;if(!result)return Response.json({success:false},{status:404});}
  else if(path.endsWith('/domains')){if(method==='POST'){remote.domains.push(body);result=body;}else result=remote.domains;}
  else if(path.endsWith('/dns_records')){if(method==='POST'){remote.dns.push(body);result=body;}else result=remote.dns;}
  else throw new Error(`unmocked_cloudflare_request:${method}:${path}`);
  return Response.json({success:true,result});
 };
 const deployments=[];
 const run=async(executable,args,options={})=>{
  if(executable==='npm')return 'built';
  if(args.includes('functions')&&args.includes('build')){const out=resolve(args[args.indexOf('--outdir')+1]);await mkdir(out,{recursive:true});await writeFile(resolve(out,'index.js'),'export default {fetch(request,env){return env.ASSETS.fetch(request)}}');return 'compiled';}
  if(args.includes('deploy')&&args.includes('--project-name')){const artifact=args[args.indexOf('deploy')+1];assert(args.includes('--no-bundle'));assert.match(await readFile(resolve(artifact,'_worker.js'),'utf8'),/ASSETS.fetch/);assert.match(await readFile(resolve(artifact,'index.html'),'utf8'),/Test installation/);return 'published';}
  if(args.includes('migrations')){const cfg=JSON.parse(await readFile(args[args.indexOf('--config')+1],'utf8')),binding=cfg.d1_databases[0],db=dbs.get(binding.database_id);db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY)');for(const file of (await readdir(binding.migrations_dir)).sort()){if(db.prepare('SELECT name FROM d1_migrations WHERE name=?').get(file))continue;db.exec(await readFile(resolve(binding.migrations_dir,file),'utf8'));db.prepare('INSERT INTO d1_migrations VALUES(?)').run(file);}return 'migrated';}
  if(args.includes('export')){const cfg=JSON.parse(await readFile(args[args.indexOf('--config')+1],'utf8'));await writeFile(args[args.indexOf('--output')+1],JSON.stringify(dbs.get(cfg.d1_databases[0].database_id).prepare("SELECT name FROM sqlite_master WHERE type='table'").all()));return 'backed-up';}
  if(args.includes('--secrets-file')){const config=JSON.parse(await readFile(args[args.indexOf('--config')+1],'utf8')),secrets=JSON.parse(await readFile(args[args.indexOf('--secrets-file')+1],'utf8'));assert(secrets.AUTH_JWT_SECRET);deployments.push({config,secrets});}
  return 'deployed';
 };
 const plan=await buildPlan(example,root);await assert.rejects(applyPlan(plan,root,{env,fetchImpl,run}),/simulated_lost_response/);
 const installed=await applyPlan(plan,root,{env,fetchImpl,run});assert.equal(installed.acceptance.status,'pending');assert.equal(remote.databases.length,2);assert.equal(remote.buckets.length,1);
 const before=JSON.parse(await readFile(resolve(directory,'state.json'),'utf8')),vaultBefore=unseal(JSON.parse(await readFile(resolve(directory,'vault.json'),'utf8')),env.WORKSPACE_VAULT_PASSWORD);
 assert.equal(vaultBefore.INSTALLER_CREDENTIALS.CLOUDFLARE_API_TOKEN,env.CLOUDFLARE_API_TOKEN);
 assert(!JSON.stringify(vaultBefore.INSTALLER_CREDENTIALS).includes(env.WORKSPACE_VAULT_PASSWORD));
 assert(!JSON.stringify(before).includes(vaultBefore.AUTH_JWT_SECRET));const authDb=dbs.get(before.resources['d1:auth'].id);authDb.exec("INSERT INTO auth_users (id,email,name,status) VALUES('saved-user','person@example.com','Person','active')");
 const coreDb=dbs.get(before.resources['d1:core'].id);
 assert.equal(coreDb.prepare('SELECT name FROM teams WHERE id=?').get(example.installationId).name,example.brand.name);
 coreDb.prepare('INSERT INTO users(id,team_id,name,email,role) VALUES(?,?,?,?,?)').run('saved-user',example.installationId,'Person','person@example.com','admin');
 await writeFile(resolve(root,'package.json'),JSON.stringify({version:'0.2.0'}));await writeFile(resolve(root,'schemas/auth/0003_upgrade_test.sql'),'CREATE TABLE upgrade_marker (id TEXT PRIMARY KEY);');
 const upgrade=await buildPlan(example,root,{upgrade:true});await applyPlan(upgrade,root,{env:{WORKSPACE_VAULT_PASSWORD:env.WORKSPACE_VAULT_PASSWORD},fetchImpl,run});assert.equal(authDb.prepare("SELECT email FROM auth_users WHERE id='saved-user'").get().email,'person@example.com');assert(authDb.prepare("SELECT name FROM sqlite_master WHERE name='upgrade_marker'").get());
 const after=JSON.parse(await readFile(resolve(directory,'state.json'),'utf8'));assert.equal(after.deployedRelease,'0.2.0');assert.deepEqual(after.resources,before.resources);assert.equal(unseal(JSON.parse(await readFile(resolve(directory,'vault.json'),'utf8')),env.WORKSPACE_VAULT_PASSWORD).AUTH_JWT_SECRET,vaultBefore.AUTH_JWT_SECRET);assert(after.backupDirectory);assert.equal(remote.databases.length,2);assert.equal(deployments.length,3);
 assert.equal(coreDb.prepare("SELECT role FROM users WHERE id='saved-user'").get().role,'admin');
 for(const db of dbs.values())db.close();
});
test('fresh core includes every built-in discussion category without user data',async()=>{
 const db=new DatabaseSync(':memory:');try{
  for(const file of(await readdir(resolve(repo,'schemas/core'))).sort())db.exec(await readFile(resolve(repo,'schemas/core',file),'utf8'));
  assert.deepEqual(db.prepare('SELECT slug FROM forum_categories ORDER BY slug').all().map(x=>x.slug),['ai-exploration','ai-investment','off-topic','platform-help']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n,0);
 }finally{db.close();}
});
