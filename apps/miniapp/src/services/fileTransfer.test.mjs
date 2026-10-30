import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Taro from '@tarojs/taro';
import { state } from '../state.ts';
import { isAuthRequiredError } from './auth.ts';

globalThis.TARO_APP_USE_MOCKS = '0';
const api = await import('./api.ts');
const { loadFilePreviewSource } = await import('./filePreviewSource.ts');
const id = 'art_01234567-89ab-cdef-0123-456789abcdef';
const url = `/api/workspace-files/${id}/raw`;
const token = { mate: { id: 'mate-qa' }, accessToken: 'old-token', conversationId: 'conversation-qa', principalKey: 'user-qa', conversationState: 'persisted', expiresAt: '2099-01-01T00:00:00Z' };
const file = { path: '/tmp/report', name: '季度报告.pdf', size: 8, type: 'file' };
let original;
function ok(data) { return {statusCode: 200, data, header: {}}; }
function metadata() { return {file: {objectId: id, fileName: file.name, mediaType: 'application/pdf', sizeBytes: file.size}}; }
beforeEach(() => { original = {...Taro}; state.clearAuth(); state.setCookie('session=qa'); state.setLiveSession({...token}); });
afterEach(() => { for (const key of Object.keys(Taro)) if (!(key in original)) delete Taro[key]; Object.assign(Taro, original); });

describe('file transfers through the native API boundary', () => {
  it('preserves Chinese names, MIME, auth and local path on multipart uploads', async () => {
    Taro.uploadFile = async options => {
      assert.equal(options.filePath, file.path); assert.equal(options.formData.fileName, file.name);
      assert.equal(options.formData.mediaType, 'application/pdf'); assert.equal(options.header.authorization, 'Bearer old-token');
      assert.equal(options.header.cookie, 'session=qa'); return {statusCode: 201, data: JSON.stringify(metadata())};
    };
    const result = await api.uploadAttachment(token, file);
    assert.equal(result.localPath, file.path); assert.equal(result.objectId, id);
  });
  it('rejects above-limit, empty, negative and malformed filenames before networking', async () => {
    Taro.uploadFile = async () => { throw Error('network must not run'); };
    for (const size of [20*1024*1024+1, 0, -1, NaN]) await assert.rejects(()=>api.uploadAttachment(token,{...file,size}), /upload_file_/);
    for (const name of ['../report.pdf','bad\u0000.pdf','', '.']) await assert.rejects(()=>api.uploadAttachment(token,{...file,name}), /upload_file_/);
  });
  it('does not treat a malformed success payload as an uploaded attachment', async () => {
    for (const data of ['<html>gateway</html>','null','{}','{"file":{"objectId":"../wrong"}}']) {
      Taro.uploadFile = async()=>({statusCode:201,data});
      await assert.rejects(()=>api.uploadAttachment(token,file), /upload_response_invalid/);
    }
  });
  it('keeps an ordinary failed upload retryable without silently issuing a second write', async () => {
    let calls=0; Taro.uploadFile=async()=>{calls++;return {statusCode:503,data:'{"error":"unavailable"}'};};
    await assert.rejects(()=>api.uploadAttachment(token,file),/unavailable/); assert.equal(calls,1);
  });
  it('renews an explicitly invalid runtime token once while retaining the conversation', async () => {
    let calls=0;let renewals=0;
    Taro.uploadFile=async options=>{ calls++;return options.header.authorization==='Bearer old-token' ? {statusCode:401,data:'{"error":"runtime_token_invalid"}'}:{statusCode:201,data:JSON.stringify(metadata())}; };
    Taro.request=async options=>{ renewals++;assert.equal(options.data.conversationId,token.conversationId);assert.equal(options.data.newConversation,undefined);return ok({session:{...token,accessToken:'new-token'}}); };
    assert.equal((await api.uploadAttachment(token,file)).objectId,id); assert.equal(calls,2);assert.equal(renewals,1);
  });
  it('does not redirect a missing file or denied file to login', async () => {
    for (const statusCode of [403,404,410]) {
      Taro.downloadFile=async()=>({statusCode,tempFilePath:'/tmp/error-body'});
      await assert.rejects(()=>api.downloadWorkspaceFile(token,url), e=>!isAuthRequiredError(e));
    }
  });
  it('requires a real nonempty temporary path from a successful download', async()=>{
    Taro.downloadFile=async()=>({statusCode:200,tempFilePath:''});
    await assert.rejects(()=>api.downloadWorkspaceFile(token,url),/download_response_invalid/);
  });
  it('decodes token-invalid download errors before renewing, without losing web auth',async()=>{
    let downloads=0;
    Taro.downloadFile=async options=>{downloads++;return {statusCode: options.header.authorization==='Bearer old-token'?401:200,tempFilePath:'/tmp/result.pdf'};};
    Taro.getFileSystemManager=()=>({readFile:options=>options.success({data:'{"error":"runtime_token_invalid"}'})});
    Taro.request=async()=>ok({session:{...token,accessToken:'new-token'}});
    assert.equal(await api.downloadWorkspaceFile(token,url),'/tmp/result.pdf'); assert.equal(downloads,2);
  });
  it('loads a user PDF or AI PDF through the same authenticated download path',async()=>{
    let calls=0;
    Taro.downloadFile=async options=>{calls++;assert.equal(options.header.authorization,'Bearer old-token');return {statusCode:200,tempFilePath:'/tmp/report.pdf'};};
    for(const origin of ['user','ai']) {
      const loaded=await loadFilePreviewSource({id:origin,name:'report.pdf',workspace:{session:token,url}},'pdf');
      assert.equal(loaded.pdfPath,'/tmp/report.pdf');
    }
    assert.equal(calls,2);
  });
  it('never reports a Knowledge save as successful without a confirmed file ID',async()=>{
    Taro.request=async()=>ok({});
    await assert.rejects(()=>api.saveWorkspaceFileToKnowledge(token,url,'folder-qa'),/knowledge_save_not_confirmed/);
  });
  it('keeps non-auth save failures to one request and preserves the original failure',async()=>{
    let count=0; Taro.request=async()=>{count++;return {statusCode:403,data:{error:'knowledge_write_forbidden'},header:{}};};
    await assert.rejects(()=>api.saveWorkspaceFileToKnowledge(token,url,'folder-qa'), e=>!isAuthRequiredError(e)); assert.equal(count,1);
  });
  it('does not send a file credential to an external or encoded path',async()=>{
    Taro.downloadFile=async()=>{throw Error('unexpected network');};
    for(const bad of ['https://evil.test/a', '/api/workspace-files/..%2fsecret/raw','/api/workspace-files/bad%00id/raw']) await assert.rejects(()=>api.downloadWorkspaceFile(token,bad),/workspace_file_reference_invalid/);
  });
});

describe('transfer recovery and large-file integrity', () => {
  it('renews concurrent files through one session exchange',async()=>{
    let renewals=0;
    Taro.uploadFile=async options=>options.header.authorization==='Bearer old-token'?{statusCode:401,data:'{"error":"runtime_token_invalid"}'}:{statusCode:201,data:JSON.stringify(metadata())};
    Taro.request=async()=>{renewals++;await Promise.resolve();return ok({session:{...token,accessToken:'new-token'}});};
    await Promise.all([api.uploadAttachment(token,file),api.uploadAttachment(token,{...file,name:'第二份.pdf'})]);
    assert.equal(renewals,1);
  });
  it('never loops on repeated token rejection',async()=>{
    let calls=0;Taro.uploadFile=async()=>{calls++;return {statusCode:401,data:'{"error":"runtime_token_invalid"}'};};
    Taro.request=async()=>ok({session:{...token,accessToken:'new-token'}});
    await assert.rejects(()=>api.uploadAttachment(token,file),/runtime_token_invalid/);assert.equal(calls,2);
  });
  it('renews an expiring draft without attaching to an old persisted conversation',async()=>{
    const draft={...token,expiresAt:'2000-01-01',conversationState:'draft',conversationId:'local-draft'};state.setLiveSession(draft);
    Taro.request=async options=>{assert.equal(options.data.newConversation,true);assert.equal(options.data.conversationId,undefined);return ok({session:{...token,conversationId:'new-server-draft',conversationState:'draft',accessToken:'new-token'}});};
    Taro.uploadFile=async options=>{assert.equal(options.header.authorization,'Bearer new-token');return {statusCode:201,data:JSON.stringify(metadata())};};
    await api.uploadAttachment(draft,file);assert.equal(state.getLiveSession().conversationId,'local-draft');assert.equal(state.getLiveSession().conversationState,'draft');
  });
  it('uploads an exact 20 MiB file as five sequential 4 MiB chunks with intact bytes',async()=>{
    const big={...file,size:20*1024*1024};let read=0;let chunks=0;let completed=0;
    Taro.getFileSystemManager=()=>({readFile(options){assert.equal(options.position,read*4*1024*1024);assert.equal(options.length,4*1024*1024);read++;options.success({data:new Uint8Array(options.length).fill(read).buffer});}});
    Taro.request=async options=>{
      if(options.url.endsWith('/file-uploads'))return ok({uploadId:id.slice(4),chunkBytes:4*1024*1024});
      if(options.method==='PUT'){assert.equal(options.data.byteLength,4*1024*1024);assert.equal(new Uint8Array(options.data)[0],++chunks);assert.equal(options.header.cookie,'session=qa');return ok({});}
      completed++;assert.equal(options.header.authorization,'Bearer old-token');return ok(metadata());
    };
    assert.equal((await api.uploadAttachment(token,big)).objectId,id);assert.equal(read,5);assert.equal(chunks,5);assert.equal(completed,1);
  });
  it('uploads the final partial chunk at 8 MiB + 1 byte',async()=>{
    const lengths=[];
    Taro.getFileSystemManager=()=>({readFile:options=>{lengths.push(options.length);options.success({data:new ArrayBuffer(options.length)});}});
    Taro.request=async options=>ok(options.url.endsWith('/file-uploads')?{uploadId:id.slice(4),chunkBytes:4*1024*1024}:options.method==='PUT'?{}:metadata());
    await api.uploadAttachment(token,{...file,size:8*1024*1024+1});assert.deepEqual(lengths,[4*1024*1024,4*1024*1024,1]);
  });
  it('stops before network transfer or completion if a local chunk was truncated',async()=>{
    let requests=0;
    Taro.getFileSystemManager=()=>({readFile:options=>options.success({data:new ArrayBuffer(options.length-1)})});
    Taro.request=async()=>{requests++;return ok({uploadId:id.slice(4),chunkBytes:4*1024*1024});};
    await assert.rejects(()=>api.uploadAttachment(token,{...file,size:9*1024*1024}),/upload_chunk_read_invalid/);assert.equal(requests,1);
  });
  it('rejects malformed upload negotiation before reading local bytes',async()=>{
    Taro.getFileSystemManager=()=>{throw Error('filesystem must not run');};
    for(const data of [{uploadId:'../bad',chunkBytes:1},{uploadId:id.slice(4),chunkBytes:0},{uploadId:id.slice(4),chunkBytes:9*1024*1024}]){
      Taro.request=async()=>ok(data);await assert.rejects(()=>api.uploadAttachment(token,{...file,size:9*1024*1024}),/upload_(response|chunk_size)_invalid/);
    }
  });
  it('does not automatically replay an uncertain large-file completion',async()=>{
    let completions=0;
    Taro.getFileSystemManager=()=>({readFile:options=>options.success({data:new ArrayBuffer(options.length)})});
    Taro.request=async options=>{
      if(options.url.endsWith('/file-uploads'))return ok({uploadId:id.slice(4),chunkBytes:4*1024*1024});
      if(options.method==='PUT')return ok({});
      completions++;throw Error('connection_lost_after_completion');
    };
    await assert.rejects(()=>api.uploadAttachment(token,{...file,size:9*1024*1024}),/connection_lost/);assert.equal(completions,1);
  });
});

describe('native preview source handling',()=>{
  it('loads Knowledge HTML and Markdown text without writing a binary preview file',async()=>{
    Taro.getFileSystemManager=()=>{throw Error('text payload needs no filesystem');};
    for(const [name,kind,body] of [['报告.html','html','<h1>季度报告</h1>'],['笔记.md','markdown','# 工作笔记']]){
      Taro.request=async()=>ok({file:{fileName:name,mimeType:kind==='html'?'text/html':'text/markdown'},content:{encoding:'text',text:body}});
      const result=await loadFilePreviewSource({id:'text',name},kind);
      assert.equal(result.text,body);assert.equal(result.truncated,false);assert.equal(result.pdfPath,undefined);
    }
  });
  it('reads authenticated workspace HTML and Markdown then releases downloaded text bytes',async()=>{
    const removed=[];
    Taro.downloadFile=async options=>{assert.equal(options.header.authorization,'Bearer old-token');return {statusCode:200,tempFilePath:'/tmp/text'};};
    const body='\uFEFF# 文件正文';
    Taro.getFileSystemManager=()=>({getFileInfo:options=>options.success({size:Buffer.byteLength(body)}),readFile:options=>{assert.equal(options.encoding,'utf8');assert.equal(options.length,Buffer.byteLength(body));options.success({data:body});},unlink:options=>{removed.push(options.filePath);options.success({});}});
    for(const kind of ['html','markdown'])assert.equal((await loadFilePreviewSource({id:kind,name:kind==='html'?'page.html':'notes.md',workspace:{session:token,url}},kind)).text,'# 文件正文');
    assert.deepEqual(removed,['/tmp/text','/tmp/text']);
  });
  it('decodes base64 Knowledge text using the device filesystem and cleans it up',async()=>{
    let written;const removed=[];Taro.env={USER_DATA_PATH:'/app-data'};
    const body='<p>中文 HTML</p>';
    Taro.request=async()=>ok({file:{fileName:'page.html',mimeType:'text/html'},content:{encoding:'base64',base64:Buffer.from(body).toString('base64')}});
    Taro.getFileSystemManager=()=>({writeFile:options=>{written=options;options.success({});},getFileInfo:options=>options.success({size:Buffer.byteLength(body)}),readFile:options=>options.success({data:Buffer.from(written.data,'base64').toString('utf8')}),unlink:options=>{removed.push(options.filePath);options.success({});}});
    assert.equal((await loadFilePreviewSource({id:'base64-html',name:'page.html'},'html')).text,body);assert.deepEqual(removed,[written.filePath]);
  });
  it('limits long text previews and releases temporary text even on read failure',async()=>{
    Taro.request=async()=>ok({file:{fileName:'long.md'},content:{encoding:'text',text:'字'.repeat(200001)}});
    const result=await loadFilePreviewSource({id:'long',name:'long.md'},'markdown');assert.equal(result.text.length,200000);assert.equal(result.truncated,true);
    let removed=false;Taro.downloadFile=async()=>({statusCode:200,tempFilePath:'/tmp/text'});
    Taro.getFileSystemManager=()=>({getFileInfo:options=>options.success({size:1}),readFile:options=>options.fail(Error('read_failed')),unlink:options=>{removed=true;options.success({});}});
    await assert.rejects(()=>loadFilePreviewSource({id:'bad',name:'page.html',workspace:{session:token,url}},'html'),/read_failed/);assert(removed);
  });
  it('handles empty local files without an invalid zero-length read and bounds large files',async()=>{
    let size=0,reads=0;const body='字'.repeat(300000);
    Taro.downloadFile=async()=>({statusCode:200,tempFilePath:'/tmp/text'});
    Taro.getFileSystemManager=()=>({getFileInfo:options=>options.success({size}),readFile:options=>{reads++;assert.equal(options.length,800000);options.success({data:body});},unlink:options=>options.success({})});
    const file={id:'text',name:'page.html',workspace:{session:token,url}};
    assert.equal((await loadFilePreviewSource(file,'html')).text,'');assert.equal(reads,0);
    size=Buffer.byteLength(body);const result=await loadFilePreviewSource(file,'html');assert(result.truncated);assert.equal(result.text.length,200000);assert.equal(reads,1);
  });
  it('never downloads unsupported files just to show information',async()=>{
    Taro.downloadFile=Taro.request=async()=>{throw Error('unsupported files must not be fetched');};
    assert.deepEqual(await loadFilePreviewSource({id:'zip',name:'archive.zip',workspace:{session:token,url}},'unsupported'),{});
  });
  it('writes Knowledge PDF bytes as base64 and keeps the correct document extension',async()=>{
    const bytes=Buffer.from('%PDF-1.4\nfixture bytes\n');let written;
    Taro.env={USER_DATA_PATH:'/app-data'};
    Taro.request=async()=>ok({file:{fileName:'季度报告.pdf',mimeType:'application/pdf'},content:{encoding:'base64',base64:bytes.toString('base64')}});
    Taro.getFileSystemManager=()=>({writeFile:options=>{written=options;options.success({});}});
    const loaded=await loadFilePreviewSource({id:'knowledge-file',name:'季度报告.pdf'},'pdf');
    assert.match(loaded.pdfPath,/\.pdf$/);assert.equal(written.encoding,'base64');assert.deepEqual(Buffer.from(written.data,'base64'),bytes);
  });
  it('does not label a corrupt text response as a usable binary file',async()=>{
    Taro.request=async()=>ok({file:{fileName:'report.pdf'},content:{encoding:'text',text:'gateway failed'}});
    await assert.rejects(()=>loadFilePreviewSource({id:'bad',name:'report.pdf'},'pdf'),/binary_content_missing/);
  });
  it('surfaces device storage failures rather than claiming a document is ready',async()=>{
    Taro.env={USER_DATA_PATH:'/app-data'};
    Taro.request=async()=>ok({file:{fileName:'report.pdf'},content:{encoding:'base64',base64:'JVBERg=='}});
    Taro.getFileSystemManager=()=>({writeFile:options=>options.fail(Error('storage_full'))});
    await assert.rejects(()=>loadFilePreviewSource({id:'bad',name:'report.pdf'},'pdf'),/storage_full/);
  });
});

it('releases each Knowledge preview file exactly once without deleting a newer preview',async()=>{
  const removed=[]; Taro.env={USER_DATA_PATH:'/app-data'};
  Taro.request=async()=>ok({file:{fileName:'report.pdf'},content:{encoding:'base64',base64:'JVBERg=='}});
  Taro.getFileSystemManager=()=>({writeFile:options=>options.success({}),unlink:options=>{removed.push(options.filePath);options.success({});}});
  const file={id:'same-file',name:'report.pdf'};
  const first=await loadFilePreviewSource(file,'pdf');const second=await loadFilePreviewSource(file,'pdf');
  assert.notEqual(first.pdfPath,second.pdfPath);
  first.dispose();first.dispose();assert.deepEqual(removed,[first.pdfPath]);
  second.dispose();assert.deepEqual(removed,[first.pdfPath,second.pdfPath]);
});

it('reuses thumbnail bytes when opening the same image through file preview',async()=>{
  const {workspaceImages}=await import('./workspaceImages.ts');let calls=0;
  workspaceImages.forget(token,url);
  Taro.downloadFile=async()=>{calls++;return {statusCode:200,tempFilePath:'/tmp/shared-preview-image'};};
  const thumbnail=workspaceImages.acquire(token,url.replace("/raw","/download"));
  const file=await loadFilePreviewSource({id:'image',name:'image.png',workspace:{session:token,url}},'image');
  assert.equal(await thumbnail.promise,file.imagePath);assert.equal(calls,1);
  thumbnail.release();workspaceImages.forget(token,url);
});

it('uses the authenticated thumbnail endpoint, and never falls back to a full download on failure', async () => {
  const requests=[];
  Taro.downloadFile=async options=>{requests.push(options);return {statusCode:200,tempFilePath:'/tmp/thumbnail.jpg'};};
  assert.equal(await api.downloadWorkspaceThumbnail(token,url),'/tmp/thumbnail.jpg');
  assert.match(requests[0].url,/\/thumbnail$/);assert.equal(requests[0].header.authorization,'Bearer old-token');
  Taro.downloadFile=async options=>{requests.push(options);return {statusCode:503,tempFilePath:'/tmp/error'};};
  await assert.rejects(api.downloadWorkspaceThumbnail(token,url));
  assert.equal(requests.length,2);assert.ok(requests.every(r=>r.url.endsWith('/thumbnail')));
});
