import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildPlan } from './plan.mjs';
import { applyPlan } from './executor.mjs';
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function jsonBody(req){let size=0,parts=[];for await(const part of req){size+=part.length;if(size>128000)throw new Error('request_too_large');parts.push(part);}return JSON.parse(Buffer.concat(parts).toString());}
export async function serveSetup(root,{port=5194,env=process.env,apply=applyPlan}={}){
 let bootstrap=randomBytes(32).toString('base64url'),session=null,sessionExpires=0,csrf=null,plan=null,credentials={},running=false,progress=[],result=null;
 const startupToken=bootstrap;
 const server=http.createServer(async(req,res)=>{
  const origin=`http://127.0.0.1:${server.address().port}`;
  const send=(status,body,headers={})=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(body));};
  try{
   if(req.headers.host!==`127.0.0.1:${server.address().port}`)return send(403,{error:'invalid_host'});
   if(req.url==='/'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",'referrer-policy':'no-referrer'});return res.end(await readFile(fileURLToPath(new URL('../ui/index.html',import.meta.url))));}
   if(req.url==='/frontier-mark.svg'&&req.method==='GET'){res.writeHead(200,{'content-type':'image/svg+xml','cache-control':'no-store'});return res.end(await readFile(fileURLToPath(new URL('../../../public/frontier-mark.svg',import.meta.url))));}
   if(['/app.js','/style.css'].includes(req.url)&&req.method==='GET'){res.writeHead(200,{'content-type':req.url.endsWith('.js')?'text/javascript':'text/css','cache-control':'no-store'});return res.end(await readFile(fileURLToPath(new URL(`../ui${req.url}`,import.meta.url))));}
   if(req.method!=='POST')return send(405,{error:'method_not_allowed'});
   if(req.headers.origin!==origin)return send(403,{error:'invalid_origin'});
   if(req.headers['content-type']!=='application/json')return send(415,{error:'json_required'});
   const body=await jsonBody(req);
   const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('workspace_setup='))?.slice(16);
   if(req.url==='/api/session'&&session&&Date.now()<sessionExpires&&equal(cookie,session)) return send(200,{csrf});
   if(req.url==='/api/session'){
    if(!bootstrap||!equal(body.token,bootstrap))return send(403,{error:'session_link_used_or_invalid'});
    bootstrap=null;sessionExpires=Date.now()+7200000;session=randomBytes(32).toString('base64url');csrf=randomBytes(32).toString('base64url');return send(200,{csrf},{'set-cookie':`workspace_setup=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200`});
   }
   if(Date.now()>=sessionExpires){session=null;csrf=null;}
   if(!session||!equal(cookie,session)||!equal(req.headers['x-setup-csrf'],csrf))return send(403,{error:'setup_session_required'});
   if(req.url==='/api/status')return send(200,{running,progress,result,plan});
   if(req.url==='/api/plan'){
    if(running)return send(409,{error:'installation_running'});
    const next=await buildPlan(body.config,root,{upgrade:body.upgrade===true});
    const refs=new Set();function scan(value){if(typeof value==='string'&&/^env:[A-Z][A-Z0-9_]*$/.test(value))refs.add(value.slice(4));else if(value&&typeof value==='object')for(const v of Object.values(value))scan(v);}scan(next.config);refs.add('WORKSPACE_VAULT_PASSWORD');
    const supplied=body.credentials??{};for(const [key,value]of Object.entries(supplied))if(!refs.has(key)||typeof value!=='string'||value.length>20000)throw new Error('invalid_credential_field');
    credentials={...credentials,...supplied};plan=next;progress=[];result=null;return send(200,{plan});
   }
   if(req.url==='/api/apply'){
    if(running)return send(409,{error:'installation_running'});if(!plan||body.planId!==plan.id)return send(409,{error:'reviewed_plan_changed'});
    running=true;result=null;send(202,{started:true});
    apply(plan,root,{env:{...env,...credentials},onProgress:event=>{progress.push(event);}}).then(value=>{result={ok:true,...value};}).catch(error=>{result={ok:false,error:error.safeCode??error.message?.split('\n')[0]??'installation_failed'};}).finally(()=>{running=false;});return;
   }
   if(req.url==='/api/claim-token'){
    if(running||!plan)return send(409,{error:'installation_not_ready'});
    const {resolve}=await import('node:path'),{readJson,unseal}=await import('./state.mjs');const vault=await readJson(resolve(root,'.workspace',plan.installationId,'vault.json'),null);if(!vault)return send(404,{error:'claim_unavailable'});const secrets=unseal(vault,credentials.WORKSPACE_VAULT_PASSWORD??env.WORKSPACE_VAULT_PASSWORD);return send(200,{token:secrets.OWNER_CLAIM_TOKEN??null,url:`https://${plan.config.domains.portalHostname}/setup/claim`});
   }
   return send(404,{error:'not_found'});
  }catch(error){send(400,{error:error.issues?'configuration_invalid':error.safeCode??error.message?.split('\n')[0]??'request_failed',...(error.issues?{fields:error.issues.map(x=>({path:x.path.join('.'),message:x.message}))}:{})});}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 return {server,url:`http://127.0.0.1:${server.address().port}/#token=${startupToken}`};
}
