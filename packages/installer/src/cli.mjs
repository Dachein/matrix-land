import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from './plan.mjs';
import { atomicJson,readJson,unseal } from './state.mjs';
import { applyPlan } from './executor.mjs';
import { serveSetup } from './local-server.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const [action='serve',...args]=process.argv.slice(2);
try{
 if(action==='serve'){const {url}=await serveSetup(root,{port:Number(args[0]??5194)});process.stdout.write(`Frontier Workspace Setup\nOpen this one-time local link:\n${url}\nKeep this process open during installation.\n`);}
 else if(action==='plan'||action==='upgrade'){
  if(!args[0])throw new Error('Usage: setup:plan -- installation.json [plan.json]; upgrade -- installation.json [upgrade-plan.json]');
  const plan=await buildPlan(JSON.parse(await readFile(resolve(args[0]),'utf8')),root,{upgrade:action==='upgrade'});const output=resolve(args[1]??`${action}-plan.json`);await atomicJson(output,plan);process.stdout.write(`Plan ${plan.id}\n${plan.steps.map(x=>`${x.id}: ${x.action}`).join('\n')}\nSaved ${output}\nReview, then: npm run setup:apply -- ${output} ${plan.id}\n`);
 }else if(action==='apply'){
  if(!args[0]||!args[1])throw new Error('Usage: setup:apply -- reviewed-plan.json <exact-plan-id>');const plan=JSON.parse(await readFile(resolve(args[0]),'utf8'));if(args[1]!==plan.id)throw new Error('plan_id_mismatch');const result=await applyPlan(plan,root,{onProgress:x=>process.stdout.write(`${x.step}: ${x.status}\n`)});process.stdout.write(JSON.stringify(result,null,2)+'\n');
 }else if(action==='status'){
  if(!/^[a-z][a-z0-9-]{2,23}$/.test(args[0]??''))throw new Error('Usage: status <installation-id>');const state=await readJson(resolve(root,'.workspace',args[0],'state.json'),null);process.stdout.write(JSON.stringify(state,null,2)+'\n');
 }else if(action==='claim-token'){
  if(!/^[a-z][a-z0-9-]{2,23}$/.test(args[0]??''))throw new Error('Usage: claim-token <installation-id>');const encrypted=await readJson(resolve(root,'.workspace',args[0],'vault.json'),null);if(!encrypted)throw new Error('installation_not_found');const vault=unseal(encrypted,process.env.WORKSPACE_VAULT_PASSWORD);process.stdout.write(`${vault.OWNER_CLAIM_TOKEN??'No active claim token'}\n`);
 }else throw new Error('Commands: serve, plan, apply, upgrade, status, claim-token');
}catch(error){process.stderr.write(`${error.issues?'Invalid configuration: '+error.issues.map(x=>x.path.join('.')+': '+x.message).join('; '):error.safeCode??error.message}\n`);process.exitCode=1;}
