const $=id=>document.getElementById(id),form=$('setup');let csrf='',plan;
const field=name=>form.elements.namedItem(name),value=name=>field(name).value.trim();
const moduleLabels={mate:'Mate',knowledge:'知识库',studio:'工作室',connections:'连接 / MCP',discussions:'讨论',models:'模型服务',operations:'运行维护',mail:'邮件',stream:'视频',miniapp:'小程序'};
for(const [id,label]of Object.entries(moduleLabels)){const item=document.createElement('label');item.className='check';const input=document.createElement('input');input.type='checkbox';input.name='module';input.value=id;item.append(input,document.createTextNode(label));$('modules').append(item);}
for(const [id,label]of Object.entries({ocean:'海蓝',forest:'森林',ink:'墨色',plum:'梅紫',clay:'陶土',teal:'青绿',indigo:'靛蓝'})){const option=document.createElement('option');option.value=id;option.textContent=label;field('palette').append(option);}
function error(message){$('error').textContent=message;$('error').hidden=false;}
async function api(path,body){const response=await fetch(`/api/${path}`,{method:'POST',headers:{'content-type':'application/json',...(csrf?{'x-setup-csrf':csrf}:{})},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error([result.error,...(result.fields??[]).map(x=>`${x.path}: ${x.message}`)].join('\n'));return result;}
const token=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'','/');
try{({csrf}=await api('session',{token}));}catch{error('本地会话链接已使用或失效。请重新启动安装服务，并打开新链接。');form.querySelector('button').disabled=true;}
field('entra').addEventListener('change',()=>{$('entraFields').hidden=value('entra')==='disabled';field('client').parentElement.hidden=value('entra')==='create';});
field('modelMode').addEventListener('change',()=>{$('modelFields').hidden=value('modelMode')==='disabled';$('serverFields').hidden=value('modelMode')!=='server';field('team').parentElement.hidden=value('modelMode')==='server';field('modelKey').parentElement.hidden=value('modelMode')==='server';});
form.addEventListener('submit',async event=>{event.preventDefault();$('error').hidden=true;const button=form.querySelector('button');button.disabled=true;
 try{
 const modules=[...form.querySelectorAll('[name="module"]:checked')].map(x=>x.value),credentials={};
 const credential=(name,key)=>{if(value(name))credentials[key]=value(name);return `env:${key}`;};
 const config={$schema:'https://frontier-workspace.org/schemas/installation/v1',schemaVersion:1,installationId:value('installationId'),brand:{name:value('name'),logoText:value('logoText'),paletteId:value('palette'),...(value('logo')?{logoUrl:value('logo')}:{})},domains:{portalHostname:value('portal'),serviceRoot:value('root')},cloudflare:{accountId:value('account'),zoneId:value('zone'),apiTokenRef:credential('cfToken','CLOUDFLARE_API_TOKEN'),...(value('runtimeToken')||modules.some(x=>['studio','mate','mail','stream','operations'].includes(x))?{runtimeTokenRef:credential('runtimeToken','WORKSPACE_RUNTIME_CF_TOKEN')}:{})},identity:{allowedEmailDomains:value('allowed').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean),senderEmail:value('sender'),ownerEmail:value('owner'),entra:{mode:value('entra')}},modules,models:{mode:value('modelMode')}};
 credential('vault','WORKSPACE_VAULT_PASSWORD');
 if(value('entra')!=='disabled'){Object.assign(config.identity.entra,{tenantId:value('tenant'),expiresAt:new Date(value('entraExpiry')).toISOString()},value('entra')==='existing'?{clientId:value('client'),clientSecretRef:credential('entraSecret','ENTRA_CLIENT_SECRET')}:{graphTokenRef:credential('entraSecret','ENTRA_GRAPH_TOKEN')});}
 if(value('modelMode')!=='disabled'){Object.assign(config.models,{baseUrl:value('modelUrl'),models:value('models').split(',').map(x=>x.trim()).filter(Boolean),maxBudget:Number(value('budget')),provisioningSecretRef:credential('modelAdmin','LITELLM_PROVISIONING_KEY')});if(value('modelMode')==='existing')Object.assign(config.models,{teamId:value('team'),serviceSecretRef:credential('modelKey','LITELLM_SERVICE_KEY')});else config.models.server={host:value('sshHost'),user:value('sshUser'),port:22,identityFile:value('sshKey'),knownHostsFile:value('sshKnown'),directory:value('sshDir'),image:value('image'),postgresImage:value('postgres'),caddyImage:value('caddy'),providerSecretRef:credential('providerKey','MODEL_PROVIDER_API_KEY'),providerModel:value('providerModel')};}
 ({plan}=await api('plan',{config,credentials,upgrade:field('upgrade').checked}));
 for(const input of form.querySelectorAll('input[type="password"]')){input.value='';input.required=false;input.placeholder='已安全提交；留空保留';}
 showReview();
 }catch(e){error(e.message);}finally{button.disabled=false;}
});
$('edit').onclick=()=>{$('review').hidden=true;form.hidden=false;};
$('apply').onclick=async()=>{try{$('error').hidden=true;await api('apply',{planId:plan.id});$('review').hidden=true;$('execution').hidden=false;document.querySelectorAll('aside li').forEach((x,i)=>x.classList.toggle('active',i===2));poll();}catch(e){error(e.message);}};
async function poll(){try{const state=await api('status',{});$('progress').textContent=state.progress.map(x=>`${x.status==='succeeded'?'✓':x.status==='failed'?'!':'…'} ${x.step}`).join('\n');if(state.running)return setTimeout(poll,1800);if(state.result?.ok){$('outcome').textContent=`部署已完成：${state.result.url}。请完成真实邮箱登录与管理员认领，随后完成已启用集成的业务验收。`;$('claim').hidden=false;}else{$('outcome').textContent='执行暂停，已保存完成步骤。修复错误后可重试当前计划。';error(state.result?.error??'执行失败');$('review').hidden=false;}}catch(e){error(e.message);}}
$('claim').onclick=async()=>{try{const claim=await api('claim-token',{});$('claimInfo').textContent=`用指定管理员邮箱登录 ${claim.url}，然后输入一次性认领令牌：${claim.token}`;$('claim').hidden=true;}catch(e){error(e.message);}};

function stepLabel(step){
 const fixed={preflight:'检查账号、域名与集成配置',backup:'备份已有数据库','litellm:server':'部署模型服务器、数据库与 HTTPS','litellm:verify':'检查模型服务、团队和密钥','entra:create':'创建 Microsoft Entra 应用','identity:initialize':'初始化邮箱白名单与管理员认领','deploy:portal':'发布工作区并连接入口域名',verify:'检查服务状态，准备登录验收'};
 if(fixed[step.id])return fixed[step.id];const [kind,name,key]=step.id.split(':');
 return kind==='resource'?`创建或核对 ${name} 资源：${plan.installationId}-${key}`:kind==='migrate'?`初始化或更新 ${name} 数据库`:kind==='stage'?`准备 ${name} 服务`:kind==='deploy'?`连接并发布 ${name} 服务`:step.action;
}
function showReview(){
 $('reviewText').textContent=`${plan.config.brand.name} · ${plan.mode==='upgrade'?'升级':'新安装'} · ${plan.resources.length} 个持久化资源 · ${plan.services.length} 项服务。执行会创建或更新以下对象。`;
 $('steps').replaceChildren();for(const step of plan.steps){const line=document.createElement('div');line.textContent=stepLabel(step);$('steps').append(line);}form.hidden=true;$('review').hidden=false;document.querySelectorAll('aside li').forEach((x,i)=>x.classList.toggle('active',i===1));
}
function restoreForm(){
 const c=plan.config,m=c.models,e=c.identity.entra,s=m.server??{};
 const fields={installationId:c.installationId,name:c.brand.name,logo:c.brand.logoUrl??'',logoText:c.brand.logoText,palette:c.brand.paletteId??'frontier',portal:c.domains.portalHostname,root:c.domains.serviceRoot,account:c.cloudflare.accountId,zone:c.cloudflare.zoneId,allowed:c.identity.allowedEmailDomains.join(', '),sender:c.identity.senderEmail,owner:c.identity.ownerEmail,entra:e.mode,tenant:e.tenantId??'',client:e.clientId??'',entraExpiry:e.expiresAt?.slice(0,10)??'',modelMode:m.mode,modelUrl:m.baseUrl??'',models:m.models?.join(', ')??'',budget:m.maxBudget??100,team:m.teamId??'',sshHost:s.host??'',sshUser:s.user??'',sshKey:s.identityFile??'',sshKnown:s.knownHostsFile??'',sshDir:s.directory??'',providerModel:s.providerModel??'',image:s.image??'',postgres:s.postgresImage??'',caddy:s.caddyImage??''};
 for(const [name,value]of Object.entries(fields))field(name).value=String(value);
 for(const input of form.querySelectorAll('[name="module"]'))input.checked=c.modules.includes(input.value);
 field('upgrade').checked=plan.mode==='upgrade';
 for(const input of form.querySelectorAll('input[type="password"]')){input.required=false;input.placeholder='已安全提交；留空保留';}
 field('entra').dispatchEvent(new Event('change'));field('modelMode').dispatchEvent(new Event('change'));
}
if(csrf){try{const state=await api('status',{});if(state.plan){plan=state.plan;restoreForm();if(state.running||state.result){form.hidden=true;$('execution').hidden=false;poll();}else showReview();}}catch(e){error(e.message);}}
