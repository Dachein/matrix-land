import test from 'node:test';
import assert from 'node:assert/strict';
import {probeModel} from './routes.ts';
const env={LITELLM_URL:'https://models.example.test',LITELLM_PROVISIONING_KEY:'management-private',DEFAULT_TEAM_ID:'team-1',WORKSPACE_MODELS_JSON:'["model-1"]'};
test('cloud model acceptance uses an expiring budgeted key and revokes it on success',async()=>{
 const calls=[];
 const result=await probeModel(env,'receipt-1',async(url,init)=>{
  const body=JSON.parse(init.body);calls.push(url.pathname);assert.equal(init.redirect,'manual');
  if(url.pathname==='/key/generate'){assert.equal(body.duration,'5m');assert.equal(body.max_budget,0.05);assert.deepEqual(body.models,['model-1']);assert.equal(body.team_id,'team-1');return Response.json({key:'sk-test-private'});}
  if(url.pathname==='/v1/chat/completions'){assert.equal(init.headers.authorization,'Bearer sk-test-private');assert.equal(body.max_completion_tokens,16);return Response.json({choices:[{message:{content:'OK'}}]});}
  assert.deepEqual(body,{keys:['sk-test-private']});return Response.json({deleted_keys:['sk-test-private']});
 });
 assert.deepEqual(calls,['/key/generate','/v1/chat/completions','/key/delete']);assert.equal(result.temporaryKeyRevoked,true);assert(!JSON.stringify(result).includes('private'));
});
test('failed model responses still revoke the temporary credential and never expose upstream text',async()=>{
 const calls=[];
 await assert.rejects(probeModel(env,'receipt-2',async(url)=>{calls.push(url.pathname);if(url.pathname==='/key/generate')return Response.json({key:'sk-private'});if(url.pathname==='/key/delete')return Response.json({});return new Response('secret-upstream-trace',{status:500});}),error=>error.message==='model_acceptance_upstream_failed');
 assert.equal(calls.at(-1),'/key/delete');
});
test('acceptance cannot report success if temporary key cleanup failed',async()=>{
 await assert.rejects(probeModel(env,'receipt-3',async(url)=>url.pathname==='/key/generate'?Response.json({key:'sk-private'}):url.pathname==='/key/delete'?new Response('',{status:503}):Response.json({choices:[{message:{content:'OK'}}]})),/model_acceptance_key_cleanup_failed/);
});

test('cloud model acceptance runs in Workers and rejects redirects before forwarding credentials',async t=>{
 const {build}=await import('esbuild');
 const {Miniflare,convertV4MiniflareOptions}=await import('miniflare');
 const bundle=await build({stdin:{contents:`
  import {probeModel} from './functions/api/installation/routes.ts';
  export default {async fetch(request,env){
   try{return Response.json(await probeModel(env,'worker-receipt'))}
   catch(error){return Response.json({error:error.message},{status:error.status||500})}
  }};`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'neutral',logLevel:'silent'});
 const calls=[];let redirectAt;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-07',bindings:env,
  outboundService:async request=>{
   const url=new URL(request.url);assert.equal(url.origin,'https://models.example.test');calls.push(url.pathname);
   if(url.pathname===redirectAt)return new Response(null,{status:307,headers:{location:'https://unapproved.test/credentials'}});
   if(url.pathname==='/key/generate')return Response.json({key:'sk-worker-test'});
   if(url.pathname==='/key/delete')return Response.json({});
   return Response.json({choices:[{message:{content:'OK'}}]});
  }}));
 t.after(()=>mf.dispose());
 assert.equal((await mf.dispatchFetch('https://portal.test/probe')).status,200);
 assert.deepEqual(calls.splice(0),['/key/generate','/v1/chat/completions','/key/delete']);
 redirectAt='/key/generate';
 assert.equal((await mf.dispatchFetch('https://portal.test/probe')).status,502);
 assert.deepEqual(calls.splice(0),['/key/generate']);
 redirectAt='/v1/chat/completions';
 assert.equal((await mf.dispatchFetch('https://portal.test/probe')).status,502);
 assert.deepEqual(calls,['/key/generate','/v1/chat/completions','/key/delete']);
});
