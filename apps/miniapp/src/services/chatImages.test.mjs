import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {chatImageDimensions,chatImageSegments,createChatImageCache} from './chatImages.ts';
const url='/api/workspace-files/art_01234567-89ab-cdef-0123-456789abcdef/raw';
const session={principalKey:'user-one',mate:{id:'mate-one'}};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
describe('inline chat image handling',()=>{
  it('keeps portrait, landscape and very tall thumbnails within the bubble',()=>{
    assert.deepEqual(chatImageDimensions(1200,800),{width:420,height:280});
    assert.deepEqual(chatImageDimensions(800,1600),{width:260,height:520});
    assert.deepEqual(chatImageDimensions(1,10000),{width:40,height:520});
    assert.deepEqual(chatImageDimensions(0,NaN),{width:400,height:300});
  });
  it('extracts generated Markdown images while preserving surrounding message text',()=>{
    const parts=chatImageSegments(`这是生成的图：\n![报告图片](${url})\n请查看。`);
    assert.equal(parts.length,3);assert.equal(parts[1].type,'image');assert.equal(parts[1].url,url.replace('/raw','/download'));assert.equal(parts[2].text,'\n请查看。');
  });
  it('keeps Markdown code literal and rejects unsafe or external image URLs',()=>{
    for(const text of [`\`![example](${url})\``,`\`\`\`md\n![example](${url})\n\`\`\``,`![bad](/api/workspace-files/..%2fsecret/raw)`,'![remote](https://example.test/image.png)'])assert.deepEqual(chatImageSegments(text),[{type:'text',text}]);
  });
  it('deduplicates in-flight thumbnail downloads and keeps the cache scoped to the user and Mate',async()=>{
    let count=0;const cache=createChatImageCache(async()=>{count++;return '/tmp/image';});
    await Promise.all([cache.load(session,url),cache.load(session,url)]);assert.equal(count,1);
    await cache.load({...session,principalKey:'other-user'},url);await cache.load({...session,mate:{id:'other-mate'}},url);assert.equal(count,3);
  });
  it('allows an explicit retry after transport failure or native image decode failure',async()=>{
    let count=0;const cache=createChatImageCache(async()=>{if(++count===1)throw Error('network');return '/tmp/image';});
    await assert.rejects(()=>cache.load(session,url));await cache.load(session,url);assert.equal(count,2);
    cache.forget(session,url);await cache.load(session,url);assert.equal(count,3);
  });
  it('limits image downloads to two at a time',async()=>{
    const finish=[];let active=0;let maximum=0;
    const cache=createChatImageCache(()=>new Promise(resolve=>{active++;maximum=Math.max(maximum,active);finish.push(()=>{active--;resolve('/tmp/image');});}));
    const tasks=[1,2,3,4].map(i=>cache.load(session,`${url}?image=${i}`));await flush();assert.equal(active,2);
    while(finish.length){finish.shift()();await flush();}
    await Promise.all(tasks);assert.equal(maximum,2);
  });
  it('evicts old thumbnails when the cache limit is exceeded',async()=>{
    let count=0;const cache=createChatImageCache(async()=>{count++;return '/tmp/image';},2);
    for(const suffix of ['one','two','three','one'])await cache.load(session,url+suffix);
    assert.equal(count,4);
  });
});

describe('legacy session image isolation',()=>{
  it('uses the token boundary when an old cache does not contain a principal key',async()=>{
    let calls=0;const cache=createChatImageCache(async()=>{calls++;return '/tmp/image';});
    await cache.load({...session,principalKey:'',accessToken:'first-user-token'},url);
    await cache.load({...session,principalKey:'',accessToken:'second-user-token'},url);
    assert.equal(calls,2);
  });
});

// More pending images than the LRU limit previously evicted active requests.
it('deduplicates a 40-image backlog even after the completed cache capacity is exceeded',async()=>{
  const finish=[];const counts=new Map();let active=0;let maximum=0;
  const cache=createChatImageCache((_session,url)=>new Promise(resolve=>{
    counts.set(url,(counts.get(url)||0)+1); active++; maximum=Math.max(maximum,active);
    finish.push(()=>{active--;resolve('/tmp/'+url);});
  }),16);
  const urls=Array.from({length:40},(_,i)=>'image-'+i);
  const first=urls.map(url=>cache.load(session,url));
  const repeated=urls.map(url=>cache.load(session,url));
  first.forEach((promise,i)=>assert.equal(promise,repeated[i]));
  await flush();
  while(finish.length){finish.shift()();await flush();}
  await Promise.all([...first,...repeated]);
  assert.equal(counts.size,40);assert.equal([...counts.values()].reduce((a,b)=>a+b,0),40);assert.equal(maximum,2);
});

it('drops offscreen queued images and keeps requests shared by another visible image',async()=>{
  const finish=[];const calls=[];
  const cache=createChatImageCache((_session,url)=>new Promise(resolve=>{calls.push(url);finish.push(()=>resolve('/tmp/'+url));}));
  const a=cache.acquire(session,'a'),b=cache.acquire(session,'b');
  const offscreen=cache.acquire(session,'offscreen');
  const rejected=assert.rejects(offscreen.promise,/image_load_cancelled/);
  offscreen.release();offscreen.release();
  const shared=cache.acquire(session,'shared'),visible=cache.acquire(session,'shared');shared.release();
  await flush();assert.deepEqual(calls,['a','b']);
  while(finish.length){finish.shift()();await flush();}
  await Promise.all([a.promise,b.promise,visible.promise,rejected]);
  assert.deepEqual(calls,['a','b','shared']);
  const again=cache.acquire(session,'offscreen');await flush();finish.shift()();await again.promise;
  assert.deepEqual(calls,['a','b','shared','offscreen']);
});
