import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '../../../../src/portal/components/Button';
import { FeedbackNotice } from '../../../../src/portal/components/FeedbackNotice';
import { useI18n } from '../../../../src/portal/i18n';
import type { PortalCatalog } from '../../../../src/shared/types';
import { PortalAdminBackups } from './PortalAdminBackups';
import './installation.css';

type Receipt = {kind:string;status:string;startedAt:number;detail:string};
type Status = {release:string;modules:string[];entraConfigured:boolean;receipts:Receipt[]};
export function PortalInstallation({catalog}:{catalog:PortalCatalog}) {
 const {locale}=useI18n(),zh=locale==='zh-CN';
 const [status,setStatus]=useState<Status>(),[owner,setOwner]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[target,setTarget]=useState(''),[transfer,setTransfer]=useState(false);
 const refresh=useCallback(async()=>{
  const [response,ownership]=await Promise.all([fetch('/api/admin/installation'),fetch('/auth/setup/ownership')]);
  if(!response.ok||!ownership.ok)throw new Error(zh?'无法读取工作区状态。':'Workspace status unavailable.');
  setStatus(await response.json() as Status);setOwner((await ownership.json() as {isOwner:boolean}).isOwner);
 },[zh]);
 useEffect(()=>{void refresh().catch(e=>setError(e.message));},[refresh]);
 async function testModel(){setBusy(true);setError('');try{const response=await fetch('/api/admin/installation/model-test',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(!response.ok)throw new Error(zh?'验证未通过，请查看验收记录并检查模型配置。':'Verification failed. Review the receipt and model settings.');}catch(e){setError((e as Error).message);}finally{await refresh().catch(e=>setError(e.message));setBusy(false);}}
 async function transferOwner(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{const response=await fetch('/auth/setup/transfer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:target.trim()})});if(!response.ok)throw new Error(zh?'移交失败，请确认接收者账号已激活。':'Transfer failed. Verify that the recipient account is active.');setTransfer(false);setTarget('');await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <div className="workspace-installation"><header><div><p>WORKSPACE</p><h1>{zh?'运行与验收':'Operations & acceptance'}</h1><span>{zh?'检查实例版本、登录方式和真实模型调用。':'Review the instance release, sign-in methods and real model calls.'}</span></div><Button onClick={()=>void refresh().catch(e=>setError(e.message))} variant="secondary">{zh?'刷新':'Refresh'}</Button></header>
 {error&&<FeedbackNotice tone="error">{error}</FeedbackNotice>}
 {!status?<p>{zh?'正在读取…':'Loading…'}</p>:<>
 <div className="workspace-installation-grid"><section><h2>{zh?'当前实例':'This instance'}</h2><dl><dt>{zh?'版本':'Release'}</dt><dd>{status.release}</dd><dt>{zh?'已启用模块':'Enabled modules'}</dt><dd>{status.modules.join(' · ')||(zh?'基础工作区':'Core workspace')}</dd><dt>{zh?'所有权':'Ownership'}</dt><dd>{owner?(zh?'你是工作区所有者':'You own this workspace'):(zh?'由现有所有者管理':'Managed by the current owner')}</dd></dl></section>
 <section><h2>{zh?'登录验收':'Sign-in acceptance'}</h2><p>{zh?'当前管理员会话已通过身份服务验证。':'The identity service verified this administrator session.'}</p>{status.entraConfigured&&<><p>{zh?'首次使用 Microsoft 登录前，先在当前已验证邮箱账号上绑定身份；绑定不会按姓名或邮箱前缀合并账号。':'Link Microsoft to your verified email account before using Microsoft sign-in. Names and email prefixes do not merge accounts.'}</p><a href="/auth/login?link=1&redirect=%2Fadmin%2Foperations">{zh?'绑定 / 验证 Microsoft 登录 →':'Link / verify Microsoft sign-in →'}</a></>}</section>
 <section><h2>{zh?'模型调用验收':'Model acceptance'}</h2>{status.modules.includes('models')?<><p>{zh?'从云端发起一次真实请求，最多输出 16 个 token。测试使用 5 分钟有效、预算上限 $0.05 的临时密钥，结束后立即撤销。':'Send one real request from the cloud, with at most 16 output tokens. A temporary key expires in 5 minutes, has a $0.05 budget, and is revoked after the test.'}</p><Button onClick={()=>void testModel()} disabled={busy} variant="primary">{zh?'运行模型验证':'Test model'}</Button></>:<p>{zh?'此实例未启用模型服务。':'Model services are disabled.'}</p>}</section>
 <section><h2>{zh?'验收记录':'Acceptance receipts'}</h2>{status.receipts.length?<ul>{status.receipts.map((receipt,index)=><li key={`${receipt.startedAt}-${index}`}><strong>{receipt.kind==='model-call'?(zh?'模型调用':'Model call'):(zh?'Microsoft 登录':'Microsoft sign-in')}</strong><span>{receipt.status==='passed'?(zh?'通过':'Passed'):receipt.status==='running'?(zh?'进行中':'Running'):(zh?'未通过':'Failed')} · {new Date(receipt.startedAt).toLocaleString(locale)}</span>{receipt.status==='failed'&&<small>{receipt.detail}</small>}</li>)}</ul>:<p>{zh?'尚无本版本的验收记录。':'No acceptance receipts for this release yet.'}</p>}</section></div>
 {owner&&<section className="workspace-ownership-transfer"><h2>{zh?'移交工作区所有权':'Transfer workspace ownership'}</h2>{!transfer?<Button variant="secondary" onClick={()=>setTransfer(true)}>{zh?'准备移交':'Prepare transfer'}</Button>:<form onSubmit={transferOwner}><p>{zh?'接收者必须已有激活的账号。移交后，新的所有者可管理所有管理员；你会保留管理员角色。':'The recipient must have an active account. They become the owner; you retain the administrator role.'}</p><label>{zh?'接收者用户 ID':'Recipient user ID'}<input value={target} onChange={event=>setTarget(event.target.value)} required /></label><label><input type="checkbox" required />{zh?'我确认将所有权交给此账号。':'I confirm this ownership transfer.'}</label><Button variant="primary" type="submit" disabled={busy}>{zh?'确认移交':'Confirm transfer'}</Button><Button variant="secondary" onClick={()=>setTransfer(false)}>{zh?'取消':'Cancel'}</Button></form>}</section>}
 {status.modules.includes('operations')&&<PortalAdminBackups catalog={catalog}/>}
 </>}
 </div>;
}
