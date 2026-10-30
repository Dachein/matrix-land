import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceThumbnail } from './workspaceThumbnail.ts';
function source(type='image/png', etag='v1') { return new Response('original-private-bytes',{headers:{'content-type':type,etag}}); }
function binding(log) { return { input(stream) { return { transform(options) { log.push(options);return this; },async output(options) {log.push(options);assert.equal(await new Response(stream).text(),'original-private-bytes');return {response:()=>new Response('small-jpeg')};} }; } }; }
function cache() {const entries=new Map();return {async match(key){return entries.get(key.url)?.clone();},async put(key,value){entries.set(key.url,value);}};}
test('thumbnail bounds pixels, disables animation and never returns private originals',async()=>{
 const log=[], response=await workspaceThumbnail(source(),binding(log),'user/mate/file');
 assert.deepEqual(log,[{width:640,height:640,fit:'scale-down'},{format:'image/jpeg',quality:75,anim:false}]);
 assert.equal(await response.text(),'small-jpeg');assert.equal(response.headers.get('content-type'),'image/jpeg');assert.equal(response.headers.get('cache-control'),'private, no-store');
});
test('cached thumbnails are versioned and isolated by user/Mate/file identity',async()=>{
 const log=[], storage=cache();
 for(const [identity,version] of [['user/mate/file','v1'],['user/mate/file','v1'],['other/mate/file','v1'],['user/mate/file','v2']]) {
   const response=await workspaceThumbnail(source('image/png',version),binding(log),identity,storage);
   assert.equal(await response.text(),'small-jpeg');assert.equal(response.headers.get('cache-control'),'private, no-store');
 }
 assert.equal(log.length,6);
});
test('missing service and invalid or oversized sources do not fall back to originals',async()=>{
 await assert.rejects(workspaceThumbnail(source(),undefined,'u'),e=>e.status===503);
 await assert.rejects(workspaceThumbnail(source('image/svg+xml'),binding([]),'u'),e=>e.status===415);
 const tooLarge=source();tooLarge.headers.set('content-length','20000001');
 await assert.rejects(workspaceThumbnail(tooLarge,binding([]),'u'),e=>e.status===413);
 const broken={input(){return {transform(){return this;},output(){throw Error('decoder unavailable');}};}};
 await assert.rejects(workspaceThumbnail(source(),broken,'u'),e=>e.status===503);
});
test('oversized transform output is rejected and cache outages remain nonfatal',async()=>{
 const huge={input(){return {transform(){return this;},async output(){return {response:()=>new Response(new Uint8Array(524289))};}};}};
 await assert.rejects(workspaceThumbnail(source(),huge,'u'),e=>e.status===503);
 const brokenCache={async match(){throw Error('cache');},async put(){throw Error('cache');}};
 assert.equal(await (await workspaceThumbnail(source(),binding([]),'u',brokenCache)).text(),'small-jpeg');
});
test('unversioned sources are never cached and streamed input cannot bypass the size cap', async () => {
 const log=[], storage=cache();
 for(let i=0;i<2;i++) {
   const original=source(); original.headers.delete('etag');
   await workspaceThumbnail(original,binding(log),'u',storage);
 }
 assert.equal(log.length,4);
 const consuming={input(stream){return {transform(){return this;},async output(){await new Response(stream).arrayBuffer();return {response:()=>new Response('small')};}};}};
 const original=new Response(new Uint8Array(20_000_001),{headers:{'content-type':'image/jpeg'}});
 await assert.rejects(workspaceThumbnail(original,consuming,'u'),e=>e.status===503);
});
