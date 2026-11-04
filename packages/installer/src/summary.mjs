import {resolve} from 'node:path';
import {atomicJson,readJson} from './state.mjs';

export async function saveSummary(root,plan,result,progress){
 const directory=resolve(root,'.workspace',plan.installationId);
 const summary={schemaVersion:1,installationId:plan.installationId,mode:plan.mode??'install',updatedAt:new Date().toISOString(),
  status:result.ok?'deployed':'incomplete',url:`https://${plan.config.domains.portalHostname}`,
  brand:plan.config.brand.name,accountId:plan.config.cloudflare.accountId,zoneId:plan.config.cloudflare.zoneId,
  ownerEmail:plan.config.identity.ownerEmail,release:plan.release,modules:plan.config.modules,
  acceptance:result.acceptance??{status:'pending'},error:result.ok?null:result.error,
  progress:progress.map(({step,status})=>({step,status})),
  nextSteps:['下载安装备份，并与凭据库密码分开保管。','用指定管理员邮箱登录，完成首次所有权认领。','完成已启用模块的真实功能验收。'],
  backupDirectory:directory};
 await atomicJson(resolve(directory,'summary.json'),summary);
 return summary;
}

export async function installationBackup(root,plan){
 const directory=resolve(root,'.workspace',plan.installationId),files={};
 for(const name of ['installation.json','state.json','vault.json','summary.json']){
  const value=await readJson(resolve(directory,name),null);
  if(!value)throw new Error('installation_backup_not_ready');
  files[name]=value;
 }
 return {schemaVersion:1,installationId:plan.installationId,
  instructions:'保管此文件，凭据库密码另存。恢复时把 files 中的四个 JSON 文件放回 .workspace/<实例标识>/；升级前另行备份云端业务数据库。此文件不是业务数据库备份。',files};
}

export async function readInstallationSummary(root,installationId){
 if(!/^[a-z][a-z0-9-]{2,23}$/.test(installationId??''))throw new Error('invalid_installation_id');
 const directory=resolve(root,'.workspace',installationId);
 const summary=await readJson(resolve(directory,'summary.json'),null);
 const config=await readJson(resolve(directory,'installation.json'),null);
 if(!summary||!config)throw new Error('installation_summary_not_found');
 return {summary,config};
}
