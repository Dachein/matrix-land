import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudflareTokenUrl} from '../ui/app.js';

const ids={accountId:'44420482579679f9392919a4dcd2a980',zoneId:'764ef377bcfc9638e08b64959bfefa0a'};
test('token consent links are scoped to the selected account and zone',()=>{
 const url=new URL(cloudflareTokenUrl({...ids,kind:'installation',modules:['knowledge']}));
 assert.equal(url.origin,'https://dash.cloudflare.com');
 assert.equal(url.pathname,'/profile/api-tokens');
 assert.equal(url.searchParams.get('accountId'),ids.accountId);
 assert.equal(url.searchParams.get('zoneId'),ids.zoneId);
 const permissions=JSON.parse(url.searchParams.get('permissionGroupKeys'));
 assert(permissions.some(p=>p.key==='queues'&&p.type==='edit'));
 assert(!permissions.some(p=>['billing','account_api_tokens'].includes(p.key)));
 assert(!permissions.some(p=>p.key==='account_settings'&&p.type==='edit'));
});
test('runtime and installation consent links only add optional product permissions when selected',()=>{
 const perms=(kind,modules)=>JSON.parse(new URL(cloudflareTokenUrl({...ids,kind,modules})).searchParams.get('permissionGroupKeys'));
 assert(!perms('runtime',['knowledge']).some(p=>p.key==='queues'));
 assert(!perms('installation',[]).some(p=>['queues','stream'].includes(p.key)));
 assert(perms('runtime',['stream']).some(p=>p.key==='stream'));
});
test('invalid account scope cannot become an all-account consent link',()=>{
 for(const accountId of ['','*','all','not-an-id'])assert.throws(()=>cloudflareTokenUrl({...ids,accountId,kind:'installation'}));
 assert.throws(()=>cloudflareTokenUrl({...ids,zoneId:'all',kind:'runtime'}));
 assert.throws(()=>cloudflareTokenUrl({...ids,kind:'other'}));
});
