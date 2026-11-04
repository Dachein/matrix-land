if(typeof document!=='undefined')await initializeSetup();
async function initializeSetup(){
const $=id=>document.getElementById(id),form=$('setup');let csrf='',plan;
const field=name=>form.elements.namedItem(name),value=name=>field(name).value.trim();
const moduleLabels={mate:'Mate',knowledge:'知识库',studio:'工作室',connections:'连接 / MCP',discussions:'讨论',models:'模型服务',operations:'运行维护',mail:'邮件',stream:'视频',miniapp:'小程序'};
for(const [id,label]of Object.entries(moduleLabels)){const item=document.createElement('label');item.className='check';const input=document.createElement('input');input.type='checkbox';input.name='module';input.value=id;item.append(input,document.createTextNode(label));$('modules').append(item);}
for(const [id,label]of Object.entries({ocean:'海蓝',forest:'森林',ink:'墨色',plum:'梅紫',clay:'陶土',teal:'青绿',indigo:'靛蓝'})){const option=document.createElement('option');option.value=id;option.textContent=label;field('palette').append(option);}
function error(message){$('error').textContent=message;$('error').hidden=false;}
for(const [id,kind]of [['createInstallToken','installation'],['createRuntimeToken','runtime']]){
 $(id).onclick=()=>{
  try{
   const modules=[...form.querySelectorAll('[name="module"]:checked')].map(input=>input.value);
   const url=cloudflareTokenUrl({accountId:value('account'),zoneId:value('zone'),kind,modules});
   $('error').hidden=true;
   window.open(url,'_blank','noopener,noreferrer');
  }catch(e){error(e.message);}
 };
}
async function api(path,body){const response=await fetch(`/api/${path}`,{method:'POST',headers:{'content-type':'application/json',...(csrf?{'x-setup-csrf':csrf}:{})},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error([result.error,...(result.fields??[]).map(x=>`${x.path}: ${x.message}`)].join('\n'));return result;}
const startup=new URLSearchParams(location.hash.slice(1)),token=startup.get('token');history.replaceState(null,'','/');
try{
 const draft=JSON.parse(sessionStorage.getItem('workspace-setup-draft')??'{}');
 for(const input of form.elements){
  if(!input.name||input.type==='password'||input.name==='module')continue;
  if(typeof draft[input.name]==='string')input.value=draft[input.name];
  else if(input.type==='checkbox'&&typeof draft[input.name]==='boolean')input.checked=draft[input.name];
 }
 for(const input of form.querySelectorAll('[name="module"]'))input.checked=draft.modules?.includes(input.value)??false;
}catch{ /* A missing or unavailable tab store does not block installation. */ }
function saveDraft(){
 const draft={modules:[...form.querySelectorAll('[name="module"]:checked')].map(input=>input.value)};
 for(const input of form.elements){
  if(!input.name||input.type==='password'||input.name==='module')continue;
  draft[input.name]=input.type==='checkbox'?input.checked:input.value;
 }
 try{sessionStorage.setItem('workspace-setup-draft',JSON.stringify(draft));}catch{}
}
form.addEventListener('input',saveDraft);form.addEventListener('change',saveDraft);
// Prefill only non-secret setup fields. Credentials must be entered locally,
// never accepted from a URL. An existing reviewed plan takes precedence below.
for(const name of ['installationId','name','logoText','defaultLocale','portal','root','account','zone','allowed','allowedEmails','sender','owner']){
 const preset=startup.get(name);if(preset&&preset.length<=300)field(name).value=preset;
}
if(startup.has('modules')){
 const selected=new Set(startup.get('modules').split(','));
 for(const input of form.querySelectorAll('[name="module"]'))input.checked=selected.has(input.value);
}
saveDraft();
try{({csrf}=await api('session',{token}));}catch{error('本地会话链接已使用或失效。请重新启动安装服务，并打开新链接。');form.querySelector('button[type="submit"]').disabled=true;}
field('entra').addEventListener('change',()=>{$('entraFields').hidden=value('entra')==='disabled';field('client').parentElement.hidden=value('entra')==='create';});
field('modelMode').addEventListener('change',()=>{$('modelFields').hidden=value('modelMode')==='disabled';$('serverFields').hidden=value('modelMode')!=='server';field('team').parentElement.hidden=value('modelMode')==='server';field('modelKey').parentElement.hidden=value('modelMode')==='server';});
form.addEventListener('submit',async event=>{event.preventDefault();$('error').hidden=true;const button=form.querySelector('button[type="submit"]');button.disabled=true;
 try{
 const modules=[...form.querySelectorAll('[name="module"]:checked')].map(x=>x.value),credentials={};
 const credential=(name,key)=>{if(value(name))credentials[key]=value(name);return `env:${key}`;};
 const apiTokenRef=credential('cfToken','CLOUDFLARE_API_TOKEN');
 if(value('cfToken')&&value('runtimeToken')&&value('cfToken')===value('runtimeToken'))throw new Error('平台运维令牌与用户资源执行令牌请分别在 Cloudflare 创建，不要填写同一个 Token。');
 const runtimeTokenRef=credential('runtimeToken','WORKSPACE_RUNTIME_CF_TOKEN');
 const config={$schema:'https://frontier-workspace.org/schemas/installation/v1',schemaVersion:1,installationId:value('installationId'),brand:{name:value('name'),logoText:value('logoText'),defaultLocale:value('defaultLocale'),paletteId:value('palette'),...(value('logo')?{logoUrl:value('logo')}:{})},domains:{portalHostname:value('portal'),serviceRoot:value('root')},cloudflare:{accountId:value('account'),zoneId:value('zone'),apiTokenRef,...(value('runtimeToken')||modules.some(x=>['studio','mate','mail','stream','operations'].includes(x))?{runtimeTokenRef}:{})},identity:{...(value('allowedEmails')?{allowedEmails:value('allowedEmails').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)}:{}),allowedEmailDomains:value('allowed').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean),senderEmail:value('sender'),ownerEmail:value('owner'),entra:{mode:value('entra')}},modules,models:{mode:value('modelMode')}};
 credential('vault','WORKSPACE_VAULT_PASSWORD');
 if(value('entra')!=='disabled'){Object.assign(config.identity.entra,{tenantId:value('tenant'),expiresAt:new Date(value('entraExpiry')).toISOString()},value('entra')==='existing'?{clientId:value('client'),clientSecretRef:credential('entraSecret','ENTRA_CLIENT_SECRET')}:{graphTokenRef:credential('entraSecret','ENTRA_GRAPH_TOKEN')});}
 if(value('modelMode')!=='disabled'){Object.assign(config.models,{baseUrl:value('modelUrl'),models:value('models').split(',').map(x=>x.trim()).filter(Boolean),maxBudget:Number(value('budget')),provisioningSecretRef:credential('modelAdmin','LITELLM_PROVISIONING_KEY')});if(value('modelMode')==='existing')Object.assign(config.models,{teamId:value('team'),serviceSecretRef:credential('modelKey','LITELLM_SERVICE_KEY')});else config.models.server={host:value('sshHost'),user:value('sshUser'),port:22,identityFile:value('sshKey'),knownHostsFile:value('sshKnown'),directory:value('sshDir'),image:value('image'),postgresImage:value('postgres'),caddyImage:value('caddy'),providerSecretRef:credential('providerKey','MODEL_PROVIDER_API_KEY'),providerModel:value('providerModel')};}
 ({plan}=await api('plan',{config,credentials,upgrade:field('upgrade').checked}));
 for(const input of form.querySelectorAll('input[type="password"]')){input.value='';input.required=false;input.placeholder='已安全提交；留空保留';}
 showReview();
 }catch(e){error(e.message);}finally{button.disabled=false;}
});
$('edit').onclick=()=>{$('review').hidden=true;form.hidden=false;};
$('apply').onclick=async()=>{try{$('error').hidden=true;await api('apply',{planId:plan.id});$('summary').hidden=true;$('review').hidden=true;$('execution').hidden=false;document.querySelectorAll('aside li').forEach((x,i)=>x.classList.toggle('active',i===2));poll();}catch(e){error(e.message);}};
async function poll(){try{const state=await api('status',{});$('progress').textContent=state.progress.map(x=>`${x.status==='succeeded'?'✓':x.status==='failed'?'!':'…'} ${x.step}`).join('\n');if(state.running)return setTimeout(poll,1800);showSummary(state);}catch(e){error(e.message);}}
$('retry').onclick=()=>showReview();
$('downloadBackup').onclick=async()=>{try{
 const backup=await api('backup',{installationId:plan.installationId}),blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download=`${plan.installationId}-installation-backup.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 $('backupNotice').textContent='已发起下载，请确认文件已保存，并将凭据库密码另存。';
}catch(e){error(e.message);}};
$('summaryEdit').onclick=()=>{
 $('summary').hidden=true;form.hidden=false;
 field('vault').required=true;field('vault').placeholder='恢复或升级时输入原凭据库密码';
 document.querySelectorAll('aside li').forEach((x,i)=>x.classList.toggle('active',i===0));
};
function showSummary(state){
 form.hidden=true;$('review').hidden=true;$('execution').hidden=true;$('summary').hidden=false;
 document.querySelectorAll('aside li').forEach((x,i)=>x.classList.toggle('active',i===3));
 $('summaryStatus').textContent=state.result?.ok?'部署已完成，真实登录和业务功能仍待验收。':`安装尚未完成：${state.result?.error??'请检查运行记录'}。修复后可继续安装。`;
 const summary=state.summary,c=plan.config;
 $('summaryDetails').replaceChildren();
 for(const [label,value]of [['登录范围',c.identity.allowedEmails?.join(' · ')??c.identity.allowedEmailDomains.join(' · ')],['工作区',c.brand.name],['默认语言',c.brand.defaultLocale==='en'?'English':'中文'],['访问入口',`https://${c.domains.portalHostname}`],['实例',plan.installationId],['版本',plan.release],['管理员',c.identity.ownerEmail],['模块',c.modules.join(' · ')||'基础工作区'],['令牌方式',c.cloudflare.runtimeTokenRef?(c.cloudflare.runtimeTokenRef===c.cloudflare.apiTokenRef?'历史配置：共用，编辑时请分开':'平台运维 / 用户资源执行分开'):'仅平台运维令牌']]){
  const term=document.createElement('dt'),detail=document.createElement('dd');term.textContent=label;detail.textContent=value;$('summaryDetails').append(term,detail);
 }
 $('summarySaved').textContent=summary?.backupDirectory?`Summary 已自动保存至 ${summary.backupDirectory}/summary.json。`:'当前安装服务尚未保存 Summary，请更新并重启本机安装器后继续。';
 $('downloadBackup').disabled=!summary?.backupDirectory;
 $('claim').hidden=!state.result?.ok;$('retry').hidden=Boolean(state.result?.ok);
 $('openWorkspace').href=`https://${c.domains.portalHostname}`;$('openWorkspace').hidden=!state.result?.ok;
}
$('claim').onclick=async()=>{try{const claim=await api('claim-token',{});$('claimInfo').textContent=`用指定管理员邮箱登录 ${claim.url}，然后输入一次性认领令牌：${claim.token}`;$('claim').hidden=true;}catch(e){error(e.message);}};

function stepLabel(step){
 const fixed={preflight:'检查账号、域名与集成配置',backup:'备份已有数据库','litellm:server':'部署模型服务器、数据库与 HTTPS','litellm:verify':'检查模型服务、团队和密钥','entra:create':'创建 Microsoft Entra 应用','identity:initialize':'初始化邮箱白名单与管理员认领','deploy:portal':'发布工作区并连接入口域名',verify:'检查服务状态，准备登录验收'};
 if(fixed[step.id])return fixed[step.id];const [kind,name,key]=step.id.split(':');
 return kind==='resource'?`创建或核对 ${name} 资源：${plan.installationId}-${key}`:kind==='migrate'?`初始化或更新 ${name} 数据库`:kind==='stage'?`准备 ${name} 服务`:kind==='deploy'?`连接并发布 ${name} 服务`:step.action;
}
function showReview(){
 $('summary').hidden=true;$('execution').hidden=true;
 $('reviewText').textContent=`${plan.config.brand.name} · ${plan.config.brand.defaultLocale==='en'?'English':'中文'} · ${plan.mode==='upgrade'?'升级':'新安装'} · ${plan.resources.length} 个持久化资源 · ${plan.services.length} 项服务。登录范围：${plan.config.identity.allowedEmails?.join('、')??plan.config.identity.allowedEmailDomains.join('、')}。执行会创建或更新以下对象。${plan.config.cloudflare.runtimeTokenRef===plan.config.cloudflare.apiTokenRef?' 当前共用一个 Cloudflare 令牌；撤销后，安装升级和工作室资源操作都会失效。':''}`;
 $('steps').replaceChildren();for(const step of plan.steps){const line=document.createElement('div');line.textContent=stepLabel(step);$('steps').append(line);}form.hidden=true;$('review').hidden=false;document.querySelectorAll('aside li').forEach((x,i)=>x.classList.toggle('active',i===1));
}
function restoreForm(){
 const c=plan.config,m=c.models,e=c.identity.entra,s=m.server??{};
 const fields={installationId:c.installationId,name:c.brand.name,logo:c.brand.logoUrl??'',logoText:c.brand.logoText,defaultLocale:c.brand.defaultLocale??'zh-CN',palette:c.brand.paletteId??'frontier',portal:c.domains.portalHostname,root:c.domains.serviceRoot,account:c.cloudflare.accountId,zone:c.cloudflare.zoneId,allowedEmails:c.identity.allowedEmails?.join(', ')??'',allowed:c.identity.allowedEmailDomains.join(', '),sender:c.identity.senderEmail,owner:c.identity.ownerEmail,entra:e.mode,tenant:e.tenantId??'',client:e.clientId??'',entraExpiry:e.expiresAt?.slice(0,10)??'',modelMode:m.mode,modelUrl:m.baseUrl??'',models:m.models?.join(', ')??'',budget:m.maxBudget??100,team:m.teamId??'',sshHost:s.host??'',sshUser:s.user??'',sshKey:s.identityFile??'',sshKnown:s.knownHostsFile??'',sshDir:s.directory??'',providerModel:s.providerModel??'',image:s.image??'',postgres:s.postgresImage??'',caddy:s.caddyImage??''};
 for(const [name,value]of Object.entries(fields))field(name).value=String(value);
 for(const input of form.querySelectorAll('[name="module"]'))input.checked=c.modules.includes(input.value);
 field('upgrade').checked=plan.mode==='upgrade';
 for(const input of form.querySelectorAll('input[type="password"]')){input.required=false;input.placeholder='已安全提交；留空保留';}
 field('entra').dispatchEvent(new Event('change'));field('modelMode').dispatchEvent(new Event('change'));
}
if(csrf){try{
 const state=await api('status',{});
 if(state.plan){plan=state.plan;restoreForm();if(state.running||state.result){form.hidden=true;$('execution').hidden=false;poll();}else showReview();}
 else if(value('installationId')){
  try{
   const saved=await api('summary',{installationId:value('installationId')});
   plan={installationId:saved.summary.installationId,release:saved.summary.release,config:saved.config,mode:saved.summary.status==='deployed'?'upgrade':saved.summary.mode};
   restoreForm();showSummary({summary:saved.summary,result:{ok:saved.summary.status==='deployed',error:saved.summary.error}});
   $('retry').hidden=true;$('claim').hidden=true;
  }catch{ /* No prior installation: continue with the new setup form. */ }
 }
}catch(e){error(e.message);}}

}

// Cloudflare signs these credentials. This URL only prepares its consent form.
export function cloudflareTokenUrl({accountId,zoneId,kind,modules=[]}) {
 if(!/^[a-f0-9]{32}$/.test(accountId)||!/^[a-f0-9]{32}$/.test(zoneId))throw new Error('请先填写正确的 Account ID 和 Zone ID。');
 if(!['installation','runtime'].includes(kind))throw new Error('invalid_token_kind');
 const permissions=[
  ['account_settings','read'],['workers_scripts','edit'],['workers_routes','edit'],
  ['workers_kv_storage','edit'],['workers_r2','edit'],['d1','edit'],
  ['page','edit'],['zone','read'],['dns','edit']
 ];
 if(kind==='installation'&&modules.some(x=>['knowledge','miniapp'].includes(x)))permissions.push(['queues','edit']);
 if(modules.includes('stream'))permissions.push(['stream','edit']);
 const url=new URL('https://dash.cloudflare.com/profile/api-tokens');
 url.search=new URLSearchParams({
  name:kind==='installation'?'Workspace Platform Operations':'Workspace User Resource Execution',
  accountId,zoneId,
  permissionGroupKeys:JSON.stringify(permissions.map(([key,type])=>({key,type})))
 }).toString();
 return url.href;
}
