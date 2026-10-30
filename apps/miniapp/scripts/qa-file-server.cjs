const http=require('http');const fs=require('fs');const path=require('path');
const {WebSocketServer}=require('ws');
const root=path.resolve(__dirname,'../../..');
const dist=process.env.QA_DIST || path.join(root,'apps/miniapp/dist');const base='/api/miniapp/v1';
const ids={user:'art_11111111-1111-4111-8111-111111111111',generated:'art_22222222-2222-4222-8222-222222222222',markdown:'art_33333333-3333-4333-8333-333333333333',html:'art_44444444-4444-4444-8444-444444444444',pdf:'art_55555555-5555-4555-8555-555555555555'};
const previewFixtures={
 'qa-html':{name:'HTML季度报告.html',mime:'text/html',text:'<!doctype html><html><head><title>报告</title><script>window.qaScriptRan=true</script></head><body><h1>2026 季度报告</h1><p style="color:#46652b">这是可以直接阅读的 HTML 正文。</p><h2>资产表现</h2><table><tr><th>资产</th><th>收益</th></tr><tr><td>投资组合</td><td>12.8%</td></tr></table><ul><li>保持长期配置</li><li>定期检查风险</li></ul></body></html>'},
 'qa-md':{name:'Markdown工作笔记.md',mime:'text/markdown',text:'# 工作笔记\n\n**P1 文件预览**已经支持正文阅读。\n\n| 类型 | 优先级 |\n|---|---|\n| HTML / Markdown | P1 |\n| 图片 / PDF | P1 |\n\n```text\n中文代码块与长文本不会溢出屏幕。\n```\n\n> 点击文件即可阅读。'},
 'qa-empty':{name:'空白笔记.md',mime:'text/markdown',text:''},
 'qa-error':{name:'读取失败.md',mime:'text/markdown',error:true}
};
const user={id:'qa-user',name:'QA User',email:'qa@example.test'};
const mate={id:'qa-mate',displayName:'QA Mate',jobRole:'Assistant',description:'Local QA',status:'published',isDefault:true};
const session={mate:mate,accessToken:'qa-token',conversationId:'conv-qa',conversationState:'persisted',principalKey:'qa-user',expiresAt:'2099-01-01T00:00:00Z'};
let messages=[{id:'user-img',role:'user',parts:[{type:'text',text:'这是我上传的图片，请查看。'},{type:'file',filename:'用户上传图片.webp',mediaType:'image/webp',url:`/api/workspace-files/${ids.user}/raw`}]},{id:'ai-img',role:'assistant',parts:[{type:'text',text:'这是 AI 生成的图片。'},{type:'file',filename:'AI生成图片.webp',mediaType:'image/webp',url:`/api/workspace-files/${ids.generated}/raw`},{type:'tool-workspace_image_generate',toolName:'workspace_image_generate',toolCallId:'image-tool',state:'output-available',output:{file:{objectId:ids.generated,fileName:'AI生成图片.webp'}}}]},{id:'ai-md',role:'assistant',parts:[{type:'text',text:`Markdown 图片：\n![内嵌图](/api/workspace-files/${ids.markdown}/raw)`},{type:'tool-workspace_image_generate',toolName:'workspace_image_generate',toolCallId:'markdown-tool',state:'output-available',output:{file:{objectId:ids.markdown,fileName:'内嵌图.webp'}}}]},{id:'ai-files',role:'assistant',parts:[{type:'text',text:'文件预览检查：'},{type:'file',filename:'测试报告.html',mediaType:'text/html',url:`/api/workspace-files/${ids.html}/raw`},{type:'file',filename:'季度报告.pdf',mediaType:'application/pdf',url:`/api/workspace-files/${ids.pdf}/raw`}]}];

// Opt-in stress fixture: 500 historical messages, 40 distinct images in the recent window.
if(process.env.QA_PERF==='1') {
 const history=Array.from({length:500},(_,i)=>({id:'history-'+i,role:i%2?'assistant':'user',parts:[{type:'text',text:`历史消息 ${i}\n`+'性能回归内容。'.repeat(80)}]}));
 const images=Array.from({length:40},(_,i)=>({type:'file',filename:`压力测试图片-${i}.webp`,mediaType:'image/webp',url:`/api/workspace-files/art_66666666-6666-4666-8666-${String(i).padStart(12,'0')}/raw`}));
 messages=[...history,{id:'stress-images',role:'assistant',parts:images},...messages];
}
const performanceScript=`<script>
window.qaPerformance={inputs:[],longTasks:[],messageMutations:0};
new PerformanceObserver(list=>{for(const entry of list.getEntries())window.qaPerformance.longTasks.push({start:entry.startTime,duration:entry.duration});}).observe({type:'longtask',buffered:true});
document.addEventListener('DOMContentLoaded',()=>{const output=document.createElement('output');output.id='qa-performance';output.hidden=true;document.body.append(output);setInterval(()=>{output.textContent=JSON.stringify(window.qaPerformance);},500);});
document.addEventListener('input',()=>{const started=performance.now();requestAnimationFrame(()=>{requestAnimationFrame(()=>window.qaPerformance.inputs.push(performance.now()-started));});});
new MutationObserver(records=>{window.qaPerformance.messageMutations+=records.filter(record=>record.target.nodeType===1?record.target.closest?.('.message-row'):record.target.parentElement?.closest('.message-row')).length;}).observe(document,{subtree:true,childList:true,characterData:true,attributes:true});
</script>`;

if(process.env.QA_CARDS==='1') messages=[
 {id:'card-user',role:'user',parts:[{type:'text',text:'请查看这份文件。'},{type:'file',filename:'2026年第三季度投资组合收益与风险分析报告_最终确认版本.pdf',mediaType:'application/pdf',sizeBytes:1258291,url:`/api/workspace-files/${ids.pdf}/raw`}]},
 {id:'card-ai',role:'assistant',parts:[{type:'text',text:'文件已生成，请点击查看。'},{type:'tool-workspace_file_create',toolName:'workspace_file_create',state:'output-available',output:{file:{objectId:ids.generated,fileName:'会议纪要与后续行动.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',sizeBytes:24576}}},{type:'file',filename:'项目资料打包归档.zip',mediaType:'application/zip',url:`/api/workspace-files/${ids.html}/raw`}]},
 {id:'card-markdown',role:'assistant',parts:[{type:'text',text:`正文里的文件：[季度报告.pdf](/api/workspace-files/${ids.pdf}/raw)\n后续说明保留。`},{type:'tool-workspace_file_create',toolName:'workspace_file_create',state:'output-available',output:{file:{objectId:ids.pdf,fileName:'季度报告.pdf'}}}]}
];

// Minimal valid single-page PDF so a native viewer can exercise actual document bytes.
function fixturePdf(){
 const text='BT /F1 18 Tf 40 100 Td (Workspace QA PDF) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`];
 let out='%PDF-1.4\n';const offsets=[0];for(const [i,obj]of objects.entries()){offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
 const start=Buffer.byteLength(out);out+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(const offset of offsets.slice(1))out+=`${String(offset).padStart(10,'0')} 00000 n \n`;out+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(out);
}

const stats={thumbnailBytes:0,originalBytes:0,thumbnails:[],downloads:[],uploads:[],submissions:[],cancels:0};let failUserImage=false;let pendingResponse;const heldUploads=[];
const cors={'access-control-allow-origin':'http://127.0.0.1:13100','access-control-allow-credentials':'true','access-control-allow-headers':'Content-Type,Authorization,Cookie','access-control-allow-methods':'GET,POST,PUT,OPTIONS'};
function respond(res,data,status=200,extra={}){res.writeHead(status,{'content-type':'application/json',...cors,...extra});res.end(Buffer.isBuffer(data)?data:typeof data==='string'?data:JSON.stringify(data));}
const api=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://127.0.0.1:13101');const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks);let body={};try{body=JSON.parse(raw.toString());}catch{}const p=url.pathname;
 if(req.method==='OPTIONS')return respond(res,{},204);
 if(process.env.QA_PREVIEWS==='1'&&p===base+'/auth/email/login')return respond(res,{challengeId:'qa-only',expiresIn:600});
 if(process.env.QA_PREVIEWS==='1'&&p===base+'/auth/email/login/verify')return respond(res,{authenticated:true,user});
 if(p==='/qa/status')return respond(res,stats);
 if(p==='/qa/fail-image'){failUserImage=true;return respond(res,{});}
 if(p==='/qa/release-uploads'){heldUploads.splice(0).forEach(f=>f());return respond(res,{});}
 if(p==='/qa/start'){pendingResponse?.start();return respond(res,{});}
 if(p==='/qa/complete'){pendingResponse?.complete();return respond(res,{});}
 if(p===base+'/auth/session')return respond(res,{authenticated:true,user});
 if(p===base+'/mates/default')return respond(res,{mate:mate});
 if(p===base+'/mates')return respond(res,{mates:[mate]});
 if(p===base+'/sessions')return respond(res,{session});
 if(p.endsWith('/chat-grants'))return respond(res,{grant:'qa-grant',expiresAt:'2099-01-01T00:00:00Z'});
 if(p.endsWith('/chat/get-messages'))return respond(res,messages);
 if(p.endsWith('/conversations'))return respond(res,{conversations:[{id:'conv-qa',title:'QA Conversation',channel:'sdk'}]});
 if(p.endsWith('/approvals'))return respond(res,{approvals:[]});
 if(p.endsWith('/runtime'))return respond(res,{capabilities:{appMcp:[],knowledge:[],models:{allowUserSelection:false,defaultModel:'qa-model',allowed:[{id:'qa-model',name:'QA Model'}]},tools:[]}});
 if(p===base+'/knowledge-library/home')return respond(res,{items:process.env.QA_KNOWLEDGE==='1'?[
  {id:'qa-private',kind:'folder',name:'Agent Workspace',effectiveRole:'owner'},
  {id:'qa-long',kind:'folder',name:'2026 年第三季度投资研究与风险分析资料库',description:'长名称和说明的移动端显示测试',effectiveRole:'owner'},
  {id:'qa-team',kind:'folder',name:'Frontier Workspace How To',description:'平台使用指南与常见问题',effectiveRole:'owner',collaboratorCount:2},
  {id:'qa-shared',kind:'folder',name:'共享资料库',description:'团队共享的工作资料',effectiveRole:'viewer'}
 ]:[],recentFiles:process.env.QA_PREVIEWS==='1'?Object.entries(previewFixtures).map(([id,file])=>({item:{objectId:id,fileName:file.name,mimeType:file.mime,sizeBytes:Buffer.byteLength(file.text||''),updatedAt:'2026-10-20T03:00:00Z'}})):[]});
 if(process.env.QA_PREVIEWS==='1'&&p.startsWith(base+'/knowledge-library/files/')){const fixture=previewFixtures[p.split('/').pop()];if(fixture?.error)return respond(res,{error:'qa_read_failure'},503);if(fixture)return respond(res,{file:{fileName:fixture.name,mimeType:fixture.mime},content:{encoding:'text',text:fixture.text}});}
 if(process.env.QA_KNOWLEDGE==='1'&&p.startsWith(base+'/knowledge-library/folders/'))return respond(res,{items:[]});
 if(p.endsWith('/workspace-attachments')||p===base+'/knowledge-library/files'){
   const request=new Request('http://localhost'+p,{method:'POST',headers:{'content-type':req.headers['content-type']},body:raw});
   let file;try{file=(await request.formData()).get('file');}catch(e){return respond(res,{error:'invalid_multipart'},400);}
   const form=await new Request('http://localhost'+p,{method:'POST',headers:{'content-type':req.headers['content-type']},body:raw}).formData();const fileName=form.get('fileName')||file?.name||'file';stats.uploads.push({path:p,name:fileName,size:file?.size,type:file?.type});
   return heldUploads.push(()=>respond(res,p.endsWith('/workspace-attachments')?{file:{objectId:ids.user,fileName,mediaType:file.type,sizeBytes:file.size,rawUrl:`/api/workspace-files/${ids.user}/raw`}}:{item:{id:'saved-file',name:fileName}},201));
 }
 const download=p.match(/\/workspace-files\/([^/]+)\/(download|thumbnail)$/);
 if(download){const id=download[1];stats[download[2]==='thumbnail'?'thumbnails':'downloads'].push(id);if(req.headers.authorization!=='Bearer qa-token')return respond(res,{error:'runtime_token_invalid'},401);if(id===ids.user&&failUserImage){failUserImage=false;return respond(res,{error:'temporary_unavailable'},503);}if(id===ids.html)return respond(res,'<h1>This must not render as a custom preview</h1>',200,{'content-type':'text/html'});if(id===ids.pdf)return respond(res,fixturePdf(),200,{'content-type':'application/pdf'});if(process.env.QA_IMAGE_DIR){const thumb=download[2]==='thumbnail';const bytes=fs.readFileSync(path.join(process.env.QA_IMAGE_DIR,thumb?'thumbnail.jpg':'original.jpg'));stats[thumb?'thumbnailBytes':'originalBytes']+=bytes.length;return respond(res,bytes,200,{'content-type':'image/jpeg'});} const pet=id===ids.user?'dewey.webp':id===ids.generated?'workspace-bot.webp':'fireball.webp';return respond(res,fs.readFileSync(path.join(root,'apps/miniapp/src/assets/mate-pets',pet)),200,{'content-type':'image/webp'});}
 return respond(res,{error:'qa_route_not_found',path:p},404);
});
const wss=new WebSocketServer({server:api});
wss.on('connection',socket=>socket.on('message',raw=>{const frame=JSON.parse(raw);if(frame.type==='cf_agent_stream_resume_request')return socket.send(JSON.stringify({type:'cf_agent_stream_resume_none',reason:'idle'}));if(frame.type==='cf_agent_chat_request_cancel'){stats.cancels++;return;}if(frame.type!=='cf_agent_use_chat_request')return;
 const body=JSON.parse(frame.init.body);stats.submissions.push(body);messages.push(body.messages[0]);const messageId='assistant-live-'+stats.submissions.length;const send=chunk=>socket.send(JSON.stringify({type:'cf_agent_use_chat_response',id:frame.id,body:JSON.stringify(chunk)}));
 pendingResponse={start(){send({type:'start',messageId});send({type:'tool-input-start',toolCallId:'qa-running',toolName:'document_read'});send({type:'data-mate-process',id:'qa-process',data:{schemaVersion:'workspace.mate-process/v1',status:'running'}});},complete(){send({type:'tool-output-available',toolCallId:'qa-running',output:{ok:true}});send({type:'data-mate-process',id:'qa-process',data:{schemaVersion:'workspace.mate-process/v1',status:'completed'}});send({type:'text-delta',id:'qa-text',delta:'已处理完成。'});socket.send(JSON.stringify({type:'cf_agent_use_chat_response',id:frame.id,done:true}));messages.push({id:messageId,role:'assistant',parts:[{type:'text',text:'已处理完成。'},{type:'data-mate-process',id:'qa-process',data:{schemaVersion:'workspace.mate-process/v1',status:'completed'}}]});}};
}));
api.listen(13101,'127.0.0.1');
http.createServer((req,res)=>{let target=path.join(dist,decodeURIComponent(req.url.split('?')[0]));if(!target.startsWith(dist+path.sep)){res.writeHead(404);return res.end();}if(!fs.existsSync(target)||fs.statSync(target).isDirectory())target=path.join(dist,'index.html');res.setHeader('content-type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png'})[path.extname(target)]||'application/octet-stream');if(process.env.QA_PERF==='1'&&path.extname(target)==='.html')return res.end(fs.readFileSync(target,'utf8').replace('</head>',performanceScript+'</head>'));fs.createReadStream(target).pipe(res);}).listen(13100,'127.0.0.1');
