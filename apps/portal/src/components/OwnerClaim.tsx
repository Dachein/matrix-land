import { useEffect, useState, type FormEvent } from 'react';
import { EmailOtpLogin } from './EmailOtpLogin';
import { Button } from '../../../../src/portal/components/Button';
import { FormField, TextInput } from '../../../../src/portal/components/FormField';
import { useI18n } from '../../../../src/portal/i18n';
import './owner-claim.css';

export function OwnerClaim() {
 const { locale } = useI18n(); const zh = locale === 'zh-CN';
 const [status,setStatus] = useState<'loading'|'login'|'claim'|'owner'|'closed'|'error'>('loading');
 const [token,setToken] = useState(''); const [busy,setBusy] = useState(false); const [error,setError] = useState('');
 useEffect(()=>{let active=true;fetch('/auth/setup/ownership',{credentials:'same-origin'}).then(async response=>{
  if(response.status===401){if(active)setStatus('login');return;}
  if(!response.ok)throw new Error('request_failed');const body=await response.json() as {isOwner:boolean;claimAvailable:boolean};
  if(active)setStatus(body.isOwner?'owner':body.claimAvailable?'claim':'closed');
 }).catch(()=>{if(active)setStatus('error');});return()=>{active=false;};},[]);
 async function claim(event: FormEvent){event.preventDefault();setBusy(true);setError('');try{
  const response=await fetch('/auth/setup/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token.trim()})});
  if(!response.ok)throw new Error('claim_failed');setToken('');setStatus('owner');
 }catch{setError(zh?'认领失败。请核对登录邮箱、认领令牌及有效期。':'Claim failed. Check your signed-in email, claim token and expiration.');}finally{setBusy(false);}}
 return <main className="workspace-owner-claim"><section><p className="workspace-owner-eyebrow">FRONTIER WORKSPACE</p><h1>{zh?'完成工作区初始化':'Complete workspace setup'}</h1>
 {status==='loading'&&<p>{zh?'正在检查登录状态…':'Checking your session…'}</p>}
 {status==='login'&&<><p>{zh?'请使用安装时指定的管理员邮箱完成验证。':'Verify the owner email specified during installation.'}</p><EmailOtpLogin loginUrl="/auth/email/login" redirect="/setup/claim" /></>}
 {status==='claim'&&<form onSubmit={claim}><p>{zh?'邮箱已验证。输入本地安装器提供的一次性认领令牌，将当前账号设为工作区所有者。':'Your email is verified. Enter the one-time token from the local installer to claim workspace ownership.'}</p><FormField htmlFor="owner-claim-token" label={zh?'一次性认领令牌':'One-time claim token'} error={error||undefined}><TextInput id="owner-claim-token" type="password" autoComplete="off" value={token} onChange={event=>setToken(event.target.value)} required /></FormField><Button variant="primary" type="submit" isLoading={busy}>{zh?'认领工作区':'Claim workspace'}</Button></form>}
 {status==='owner'&&<><p>{zh?'你已成为工作区所有者。邮箱登录和所有权认领已完成。':'You are the workspace owner. Email login and ownership verification are complete.'}</p><a href="/admin/operations">{zh?'继续运行与集成验收 →':'Continue operational acceptance →'}</a></>}
 {status==='closed'&&<p>{zh?'工作区已完成认领，请联系现有所有者。':'This workspace has already been claimed. Contact its current owner.'}</p>}
 {status==='error'&&<p role="alert">{zh?'暂时无法读取安装状态，请确认身份服务和数据库迁移已完成。':'Setup status is unavailable. Check the identity service and database migrations.'}</p>}
 </section></main>;
}
