import { mkdir, writeFile, readFile, rm, cp, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { buildPlan } from './plan.mjs';
import { registry } from './registry.mjs';
import { atomicJson, readJson, seal, unseal, withLock, runSteps } from './state.mjs';
import { resolveSecret, validateCredentials, installationCredentials } from './config.mjs';
import { Cloudflare } from './cloudflare.mjs';
import { renderWorker, runtimeVariables } from './render.mjs';
import { command } from './process.mjs';
import { initializeEntra, initializeLiteLLM } from './integrations.mjs';
import { deployServer, backupAndRestoreServer } from './server.mjs';
import { deployWithMetadataRetry } from './deployRetry.mjs';
import { backupFtsDatabase } from './databaseBackup.mjs';

export async function applyPlan(plan,root,{directory=resolve(root,'.workspace',plan.installationId),env=process.env,fetchImpl=fetch,run=command,onProgress=()=>{}}={}){
 const expected=await buildPlan(plan.config,root,{upgrade:plan.mode==='upgrade'});if(expected.id!==plan.id)throw new Error('reviewed_plan_changed_regenerate_plan');
 const previousEncrypted=await readJson(resolve(directory,'vault.json'),null);
 const previousVault=previousEncrypted?unseal(previousEncrypted,env.WORKSPACE_VAULT_PASSWORD):null;
 env={...previousVault?.INSTALLER_CREDENTIALS,...env};
 validateCredentials(plan.config,env);
 return withLock(directory,async()=>{
  const statePath=resolve(directory,'state.json'),vaultPath=resolve(directory,'vault.json');
  let state=await readJson(statePath,{installationId:plan.installationId,resources:{},steps:{}});
  if(state.installationId!==plan.installationId)throw new Error('installation_state_mismatch');
  if(state.planId&&state.planId!==plan.id){if((state.deployedRelease&&plan.mode!=='upgrade')||(!state.deployedRelease&&state.configHash!==plan.configHash))throw new Error('different_plan_requires_upgrade_or_separate_directory');state.history??=[];state.history.push({planId:state.planId,release:state.deployedRelease,steps:state.steps});state.steps={};}
  if(plan.mode==='upgrade'&&!state.deployedRelease)throw new Error('upgrade_requires_deployed_installation');
  state.planId=plan.id;state.configHash=plan.configHash;
  const save=()=>atomicJson(statePath,state),password=env.WORKSPACE_VAULT_PASSWORD;
  if(!password||password.length<16)throw new Error('set_WORKSPACE_VAULT_PASSWORD_minimum_16_characters');
  const vault=previousVault??{};
  vault.INSTALLER_CREDENTIALS=installationCredentials(plan.config,env);
  const saveVault=()=>atomicJson(vaultPath,seal(vault,password));
  for(const name of new Set(plan.services.flatMap(s=>registry[s].secrets??[]).filter(k=>!k.startsWith('LITELLM_'))))vault[name]??=randomBytes(32).toString('base64url');
  // The caller and verifier use the same secret under their boundary-specific names.
  vault.MATE_AUTH_SERVICE_TOKEN=vault.MATE_RUNTIME_AUTH_SERVICE_TOKEN;
  if(!state.deployedRelease)vault.OWNER_CLAIM_TOKEN??=randomBytes(32).toString('base64url');
  await saveVault();await save();await atomicJson(resolve(directory,'installation.json'),plan.config);
  const cf=new Cloudflare(plan.config.cloudflare,{fetchImpl,env}),generated=resolve(directory,'generated');await mkdir(generated,{recursive:true,mode:0o700});
  const childEnv={...env,CLOUDFLARE_API_TOKEN:resolveSecret(plan.config.cloudflare.apiTokenRef,env),CLOUDFLARE_ACCOUNT_ID:plan.config.cloudflare.accountId,WRANGLER_SEND_METRICS:'false',CI:'1'};
  const wrangler=resolve(root,'node_modules/wrangler/bin/wrangler.js');
  const wr=(args,options={})=>run(process.execPath,[wrangler,...args],{cwd:root,env:childEnv,...options});
  async function configFor(name,stage=false){const file=resolve(generated,`${name}${stage?'-stage':''}.json`);await atomicJson(file,renderWorker(name,plan,state,root,{stage}));return file;}
  function secretsFor(name){const result=Object.fromEntries((registry[name].secrets??[]).filter(k=>vault[k]).map(k=>[k,vault[k]]));if(plan.config.models.mode!=='disabled'&&['portal','apps','mcp','gateway'].includes(name))result.LITELLM_PROVISIONING_KEY=vault.LITELLM_PROVISIONING_KEY;if(name==='mate'&&vault.MATE_LLM_KEY)result.MATE_LLM_KEY=vault.MATE_LLM_KEY;if(name==='auth'&&vault.ENTRA_CLIENT_SECRET)result.ENTRA_CLIENT_SECRET=vault.ENTRA_CLIENT_SECRET;const runtimeRef=plan.config.cloudflare.runtimeTokenRef;if(runtimeRef&&['apps','mail','stream','backup'].includes(name)){const key=resolveSecret(runtimeRef,env);result[name==='stream'?'CF_STREAM_API_TOKEN':name==='backup'?'BACKUP_CF_SOURCE_READ_TOKEN':'CF_API_TOKEN']=key;}return result;}
  async function execute(step){const [kind,name,key]=step.id.split(':');
   if(step.id==='preflight'){
    const info=await cf.preflight(plan);state.zoneName=info.zoneName;await save();
    if(plan.config.models.mode!=='disabled')resolveSecret(plan.config.models.provisioningSecretRef,env);
    if(plan.config.models.mode==='existing')resolveSecret(plan.config.models.serviceSecretRef,env);
    if(plan.services.some(x=>['apps','stream','backup','mail'].includes(x))&&!plan.config.cloudflare.runtimeTokenRef)throw new Error('cloudflare_runtime_token_reference_required');
    if(plan.config.identity.entra.mode==='existing')await initializeEntra(plan.config,state,vault,{save,saveVault,env,fetchImpl});
    await run('npm',['run','build'],{cwd:root,env:childEnv});return info;
   }
   if(step.id==='backup'){
    const dir=resolve(directory,'backups',plan.id.slice(0,16));await mkdir(dir,{recursive:true,mode:0o700});
    for(const [resource,value]of Object.entries(state.resources).filter(([r])=>r.startsWith('d1:'))){const database=resource.slice(3),file=resolve(dir,`${database}.sql`),cfg=resolve(generated,`backup-${database}.json`);await atomicJson(cfg,{name:'workspace-backup-export',compatibility_date:'2026-10-01',d1_databases:[{binding:'DB',database_id:value.id,database_name:value.name}]});if(database==='knowledge')await backupFtsDatabase(cf,value.id,file,{fetchImpl});else await wr(['d1','export',value.name,'--remote','--config',cfg,'--output',file]);}
    state.backupDirectory=dir;await save();return {directory:dir,databases:Object.keys(state.resources).filter(x=>x.startsWith('d1:')).length};
   }
   if(step.id==='litellm:server')return deployServer(plan.config,vault,{saveVault,env,run});
   if(step.id==='litellm:verify'){const result=await initializeLiteLLM(plan.config,state,vault,{save,saveVault,env,fetchImpl});if(plan.config.models.mode==='server'){state.serverBackup=await backupAndRestoreServer(plan.config,{env,run});await save();}return result;}
   if(step.id==='entra:create')return initializeEntra(plan.config,state,vault,{save,saveVault,env,fetchImpl});
   if(kind==='resource'){const r=plan.resources.find(x=>x.kind===name&&x.key===key),id=`${name}:${key}`;state.resources[id]=await cf.ensureResource(r,state.resources[id],async value=>{state.resources[id]=value;await save();});await save();return state.resources[id];}
   if(kind==='migrate'){
    const resource=state.resources[`d1:${name}`],cfg=resolve(generated,`migrate-${name}.json`);await atomicJson(cfg,{name:`${plan.installationId}-migration`,compatibility_date:'2026-10-01',d1_databases:[{binding:'DB',database_name:resource.name,database_id:resource.id,migrations_dir:resolve(root,'schemas',name)}]});
    await wr(['d1','migrations','apply',resource.name,'--remote','--config',cfg]);return {databaseId:resource.id};
   }
   if(step.id==='identity:initialize'){
    const vars=runtimeVariables(plan,state);
    await cf.query(state.resources['d1:core'].id,'INSERT INTO teams(id,name,slug) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',[vars.DEFAULT_TEAM_ID,vars.DEFAULT_TEAM_NAME,plan.installationId]);
    const id=state.resources['d1:auth'].id;
    await cf.query(id,'UPDATE auth_login_email_policy SET mode = ?, allowed_domains_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',['company_email_only',JSON.stringify(plan.config.identity.allowedEmailDomains)]);
    if(!state.deployedRelease){const hash=createHash('sha256').update(vault.OWNER_CLAIM_TOKEN).digest('base64url'),now=Math.floor(Date.now()/1000);await cf.query(id,`INSERT INTO workspace_bootstrap_claim(id,token_hash,email,expires_at,created_at) SELECT 1,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM workspace_ownership) ON CONFLICT(id) DO NOTHING`,[hash,plan.config.identity.ownerEmail,now+86400,now]);}
    return {policy:'company_email_only',ownership:'requires-verified-email-claim'};
   }
   if(kind==='stage'||(kind==='deploy'&&name!=='portal')){
    if(kind==='stage'&&state.deployedServices?.includes(name))return {skipped:'existing-service'};
    const cfg=await configFor(name,kind==='stage'),secrets=resolve(generated,`${name}.secrets.json`);await atomicJson(secrets,secretsFor(name));
    try{await deployWithMetadataRetry(()=>wr(['deploy','--config',cfg,'--secrets-file',secrets,'--no-autoconfig']),{accountId:plan.config.cloudflare.accountId,workerName:`${plan.installationId}-${name}`,onRetry:({attempt})=>onProgress({step:step.id,status:'retrying',attempt})});}finally{await rm(secrets,{force:true});}return {worker:`${plan.installationId}-${name}`};
   }
   if(step.id==='deploy:portal'){
    const project=`${plan.installationId}-portal`,projectPath=`/pages/projects/${project}`;
    const existing=await cf.request(projectPath,{missing:true});if(existing&&!state.portalProject)throw new Error('pages_project_not_owned');
    if(!existing){state.portalProject={name:project,status:'creating'};await save();await cf.request('/pages/projects',{method:'POST',body:{name:project,production_branch:'main'}});}
    const cwd=resolve(generated,'portal');await mkdir(cwd,{recursive:true,mode:0o700});await atomicJson(resolve(cwd,'wrangler.json'),renderWorker('portal',plan,state,root));
    // Publish a complete artifact instead of relying on Pages' temporary build
    // beside a symlinked functions directory. All file-based routes and
    // middleware are compiled into the stable advanced-mode Worker first.
    await rm(resolve(cwd,'functions'),{force:true});
    const artifact=resolve(cwd,'artifact'),bundle=resolve(cwd,'functions-bundle');
    await rm(artifact,{recursive:true,force:true});await rm(bundle,{recursive:true,force:true});
    await cp(resolve(root,'dist'),artifact,{recursive:true});
    await wr(['pages','functions','build',resolve(root,'functions'),'--outdir',bundle,'--compatibility-date','2026-10-01','--compatibility-flags','nodejs_compat','global_fetch_strictly_public'],{cwd});
    await cp(resolve(bundle,'index.js'),resolve(artifact,'_worker.js'));
    await wr(['pages','secret','bulk','--project-name',project],{cwd,input:JSON.stringify(secretsFor('portal'))});
    await wr(['pages','deploy',artifact,'--project-name',project,'--branch','main','--no-bundle'],{cwd});
    const domain=plan.config.domains.portalHostname;const domains=await cf.request(`${projectPath}/domains`);
    if(!domains.some(x=>x.name===domain))await cf.request(`${projectPath}/domains`,{method:'POST',body:{name:domain}});
    const records=await cf.request(`/zones/${plan.config.cloudflare.zoneId}/dns_records?name=${encodeURIComponent(domain)}`,{global:true});
    if(records.length&&!records.some(x=>x.type==='CNAME'&&x.content===`${project}.pages.dev`))throw new Error('portal_dns_record_conflict');
    if(!records.length)await cf.request(`/zones/${plan.config.cloudflare.zoneId}/dns_records`,{global:true,method:'POST',body:{type:'CNAME',name:domain,content:`${project}.pages.dev`,proxied:true,ttl:1,comment:`Frontier Workspace ${plan.installationId}`}});
    state.portalProject={name:project,status:'deployed'};await save();return {url:`https://${domain}`};
   }
   if(step.id==='verify'){
    const checks=[];
    for(const name of plan.services.filter(n=>n!=='gateway')){const hostname=name==='portal'?plan.config.domains.portalHostname:plan.config.domains.services[registry[name].domain??name],path=name==='portal'?'/api/public/brand':name==='miniapp'?'/api/miniapp/v1/health':'/health';const response=await fetchImpl(`https://${hostname}${path}`,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error(`deployed_health_failed:${name}:${response.status}`);const body=await response.json();if(name==='portal'?!body.brand:body.ok!==true)throw new Error(`deployed_health_invalid:${name}`);checks.push({service:name,status:'passed'});}
    state.deployedServices=plan.services;state.deployedRelease=plan.release;state.deployedFingerprint=plan.fingerprint;state.acceptance={status:'pending',checks:['owner-email-login-and-claim',...(plan.config.identity.entra.mode==='disabled'?[]:['entra-real-login']),...(plan.config.models.mode==='disabled'?[]:['model-call-from-cloud'])]};await save();return {checks,acceptance:state.acceptance};
   }
   throw new Error(`unsupported_step:${step.id}`);
  }
  await runSteps(plan,state,save,execute,onProgress);return {installationId:state.installationId,release:state.deployedRelease,url:`https://${plan.config.domains.portalHostname}`,acceptance:state.acceptance};
 });
}
