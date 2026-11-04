import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveConfig } from './config.mjs';
import { registry, selectedServices } from './registry.mjs';
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export async function releaseFingerprint(root){const files=[];async function walk(path){for(const e of await readdir(resolve(root,path),{withFileTypes:true})){if(e.isSymbolicLink()||['node_modules','dist','.build','.wrangler'].includes(e.name))continue;const p=`${path}/${e.name}`;if(e.isDirectory())await walk(p);else if(!/\.test\.|\.spec\./.test(p))files.push(p);}}for(const p of ['apps','src','functions','workers','sdk','packages','schemas','public'])await walk(p);files.push('package.json','package-lock.json','vite.config.ts');const h=createHash('sha256');for(const file of files.sort())h.update(file).update(await readFile(resolve(root,file)));return h.digest('hex');}
export async function buildPlan(input,root,{upgrade=false}={}){
 const config=resolveConfig(input),services=selectedServices(config),resources=[];
 const add=(kind,key)=>{if(!resources.some(r=>r.kind===kind&&r.key===key))resources.push({kind,key,name:`${config.installationId}-${key}`});};
 for(const name of services){const s=registry[name];for(const key of Object.values(s.db??{}))add('d1',key);for(const key of Object.values(s.r2??{}))add('r2',key);for(const key of s.queues??[])add('queue',key);}
 const release=JSON.parse(await readFile(resolve(root,'package.json'),'utf8')).version;
 const fingerprint=await releaseFingerprint(root);
 const steps=[{id:'preflight',action:'Verify account, zone, credentials and integration configuration'}];
 if(upgrade)steps.push({id:'backup',action:'Export each managed D1 database before changes'});
 if(config.models.mode==='server')steps.push({id:'litellm:server',action:'Deploy pinned LiteLLM + PostgreSQL + HTTPS on the configured SSH host'});
 if(config.models.mode!=='disabled')steps.push({id:'litellm:verify',action:'Verify database readiness, team and configured runtime key'});
 if(config.identity.entra.mode==='create')steps.push({id:'entra:create',action:'Create single-tenant Entra application, service principal and credential'});
 for(const r of resources)steps.push({id:`resource:${r.kind}:${r.key}`,action:`Create or verify ${r.kind} ${r.name}`});
 for(const r of resources.filter(x=>x.kind==='d1'))steps.push({id:`migrate:${r.key}`,action:`Apply forward migrations to ${r.name}`});
 steps.push({id:'identity:initialize',action:'Configure email allowlist and one-time owner claim'});
 for(const name of services.filter(n=>n!=='portal'))steps.push({id:`stage:${name}`,action:`Stage ${name} without public routes`});
 for(const name of services.filter(n=>n!=='portal'))steps.push({id:`deploy:${name}`,action:`Bind and publish ${name}`});
 steps.push({id:'deploy:portal',action:'Publish Portal and attach its domain'},{id:'verify',action:'Check deployed services and record business acceptance requirements'});
 const plan={schemaVersion:1,installationId:config.installationId,mode:upgrade?'upgrade':'install',release,fingerprint,configHash:digest(config),config,services,resources,steps,externalRequirements:['Cloudflare account with an owned DNS zone and email sending enabled; verify Free plan limits for selected services before considering Paid','For optional services: supplier credentials and supported Cloudflare capabilities; separate products may incur charges','Owner must complete a real email login and one-time claim after deployment']};
 return {...plan,id:digest(plan)};
}
