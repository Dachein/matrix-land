import { randomBytes, randomUUID } from 'node:crypto';
import { resolveSecret } from './config.mjs';
export async function apiJson(base,path,token,{method='GET',body,missing=false,fetchImpl=fetch}={}){
 const url=new URL(path,base);if(url.origin!==new URL(base).origin)throw new Error('integration_target_changed');
 const response=await fetchImpl(url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(45000)});
 if(missing&&response.status===404)return undefined;
 if(!response.ok){const e=new Error(`integration_http_${response.status}:${url.pathname}`);e.safeCode=e.message;throw e;}
 if(response.status===204)return {};try{return await response.json();}catch{throw new Error('integration_invalid_json');}
}
export async function verifyLiteLLM(config,{token,serviceKey,teamId,fetchImpl=fetch}){
 const call=(path,options)=>apiJson(config.baseUrl,path,token,{...options,fetchImpl});
 const readiness=await call('/health/readiness');
 if(!['connected','ok','healthy'].includes(String(readiness.db??readiness.database??'').toLowerCase()))throw new Error('litellm_database_not_ready');
 const team=await call(`/team/info?team_id=${encodeURIComponent(teamId)}`);if((team.team_info?.team_id??team.team_id)!==teamId)throw new Error('litellm_team_mismatch');
 const models=await apiJson(config.baseUrl,'/v1/models',serviceKey,{fetchImpl});const allowed=new Set((models.data??[]).map(x=>x.id));if(config.models.some(x=>!allowed.has(x)))throw new Error('litellm_model_unavailable');
 const key=await call(`/key/info?key=${encodeURIComponent(serviceKey)}`);if(key.info?.team_id!==teamId)throw new Error('litellm_runtime_key_team_mismatch');
 return {teamId,models:config.models,readiness:'configuration-verified',modelCall:'pending-cloud-acceptance'};
}
export async function initializeLiteLLM(config,state,vault,{save,saveVault,env=process.env,fetchImpl=fetch}){
 const model=config.models;if(model.mode==='disabled')return {};
 if(model.mode==='existing'){
  vault.LITELLM_PROVISIONING_KEY=resolveSecret(model.provisioningSecretRef,env);vault.MATE_LLM_KEY=resolveSecret(model.serviceSecretRef,env);await saveVault();state.litellmTeamId=model.teamId;await save();
  return verifyLiteLLM(model,{token:vault.LITELLM_PROVISIONING_KEY,serviceKey:vault.MATE_LLM_KEY,teamId:model.teamId,fetchImpl});
 }
 const token=resolveSecret(model.provisioningSecretRef,env),call=(path,options)=>apiJson(model.baseUrl,path,token,{...options,fetchImpl});
 if(!state.litellmTeamId){state.litellmTeamId=randomUUID();await save();}
 const team=await call(`/team/info?team_id=${state.litellmTeamId}`,{missing:true});
 if(!team)await call('/team/new',{method:'POST',body:{team_id:state.litellmTeamId,team_alias:config.installationId,models:model.models,max_budget:model.maxBudget,budget_duration:'30d',metadata:{installation_id:config.installationId}}});
 const userId=`workspace-installer-${config.installationId}`;
 const user=await call(`/user/info?user_id=${encodeURIComponent(userId)}`,{missing:true});
 if(!user)await call('/user/new',{method:'POST',body:{user_id:userId,user_role:'proxy_admin',auto_create_key:false}});
 for(const [purpose,target,keyType]of [['provisioning','LITELLM_PROVISIONING_KEY','management'],['mate','MATE_LLM_KEY','llm_api']]){
  if(vault[target])continue;
  state.litellmIntents??={};state.litellmIntents[purpose]??={alias:`${config.installationId}-${purpose}-${randomBytes(6).toString('hex')}`};await save();
  const intent=state.litellmIntents[purpose];
  // The API has no universal idempotency header. Reconcile an interrupted creation by its unique recorded alias.
  let page=1;do{const list=await call(`/key/list?team_id=${state.litellmTeamId}&return_full_object=true&size=100&page=${page}`);for(const key of list.keys??[]){if(key.key_alias===intent.alias&&key.metadata?.installation_id===config.installationId){await call('/key/delete',{method:'POST',body:{keys:[key.token]}});}}if(page>=(list.total_pages??1))break;if(page++>100)throw new Error('litellm_key_reconciliation_limit');}while(true);
  const result=await call('/key/generate',{method:'POST',body:{key_alias:intent.alias,user_id:userId,team_id:state.litellmTeamId,key_type:keyType,models:model.models,max_budget:model.maxBudget,budget_duration:'30d',metadata:{installation_id:config.installationId,purpose}}});
  if(typeof result.key!=='string'||!result.key.startsWith('sk-'))throw new Error('litellm_key_response_missing');vault[target]=result.key;await saveVault();intent.status='created';await save();
 }
 return verifyLiteLLM(model,{token:vault.LITELLM_PROVISIONING_KEY,serviceKey:vault.MATE_LLM_KEY,teamId:state.litellmTeamId,fetchImpl});
}
export async function initializeEntra(config,state,vault,{save,saveVault,env=process.env,fetchImpl=fetch}){
 const entra=config.identity.entra;if(entra.mode==='disabled')return {};
 if(entra.mode==='existing'){vault.ENTRA_CLIENT_SECRET=resolveSecret(entra.clientSecretRef,env);state.entraClientId=entra.clientId;await saveVault();await save();return {clientId:entra.clientId,loginAcceptance:'pending'};}
 const token=resolveSecret(entra.graphTokenRef,env),base='https://graph.microsoft.com',call=(path,options)=>apiJson(base,`/v1.0${path}`,token,{...options,fetchImpl});
 state.entraUniqueName??=`workspace-${config.installationId}-${randomBytes(8).toString('hex')}`;await save();
 let app=await call(`/applications(uniqueName='${state.entraUniqueName}')`,{missing:true});
 if(!app)app=await call('/applications',{method:'POST',body:{uniqueName:state.entraUniqueName,displayName:`${config.brand.name} — Workspace`,signInAudience:'AzureADMyOrg',web:{redirectUris:[`https://${config.domains.portalHostname}/auth/entra/callback`]}}});
 if(app.signInAudience!=='AzureADMyOrg'||!app.web?.redirectUris?.includes(`https://${config.domains.portalHostname}/auth/entra/callback`))throw new Error('entra_application_configuration_drift');
 state.entraObjectId=app.id;state.entraClientId=app.appId;await save();
 const principals=await call(`/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${app.appId}'`)}`);if(!principals.value?.length)await call('/servicePrincipals',{method:'POST',body:{appId:app.appId}});
 if(!vault.ENTRA_CLIENT_SECRET){const displayName=`workspace-installer-${state.entraUniqueName}`;for(const p of app.passwordCredentials??[])if(p.displayName===displayName)await call(`/applications/${app.id}/removePassword`,{method:'POST',body:{keyId:p.keyId}});const password=await call(`/applications/${app.id}/addPassword`,{method:'POST',body:{passwordCredential:{displayName,endDateTime:entra.expiresAt}}});if(!password.secretText)throw new Error('entra_credential_response_missing');vault.ENTRA_CLIENT_SECRET=password.secretText;await saveVault();state.entraCredentialId=password.keyId;await save();}
 return {clientId:app.appId,loginAcceptance:'pending',expiresAt:entra.expiresAt};
}
