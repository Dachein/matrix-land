import { workspaceModulesFromEnv } from '../../../src/shared/workspaceModules.ts';
import { requireAdminPortalUser } from '../identity/index.ts';
import { HttpError, json, requireDb } from '../http.ts';
import type { ApiRouteHandler } from '../routeTypes.ts';
import type { Env } from '../env.ts';

export async function probeModel(env: Pick<Env, 'LITELLM_URL' | 'LITELLM_PROVISIONING_KEY' | 'DEFAULT_TEAM_ID' | 'WORKSPACE_MODELS_JSON'>, receiptId: string, fetchImpl = fetch) {
 const base = new URL(env.LITELLM_URL ?? '');
 if (base.protocol !== 'https:' || base.username || base.password || !env.LITELLM_PROVISIONING_KEY || !env.DEFAULT_TEAM_ID) throw new HttpError(503, 'model_acceptance_not_configured');
 const models = JSON.parse(env.WORKSPACE_MODELS_JSON ?? '[]') as unknown;
 if (!Array.isArray(models) || typeof models[0] !== 'string') throw new HttpError(503, 'model_acceptance_not_configured');
 const model = models[0];
 const call = async (path: string, key: string, body: unknown) => {
  const response = await fetchImpl(new URL(path, base), {method:'POST', redirect:'error', signal:AbortSignal.timeout(25000), headers:{authorization:`Bearer ${key}`,'content-type':'application/json'}, body:JSON.stringify(body)});
  if (!response.ok) throw new HttpError(502, 'model_acceptance_upstream_failed');
  return await response.json() as Record<string, unknown>;
 };
 let key: string | undefined;
 try {
  const generated = await call('/key/generate', env.LITELLM_PROVISIONING_KEY, {team_id:env.DEFAULT_TEAM_ID, models:[model], duration:'5m', max_budget:0.05, key_alias:`acceptance-${receiptId}`, key_type:'llm_api', metadata:{purpose:'workspace-acceptance'}});
  if (typeof generated.key !== 'string' || !generated.key.startsWith('sk-')) throw new HttpError(502, 'model_acceptance_key_invalid');
  key = generated.key;
  const result = await call('/v1/chat/completions', key, {model, messages:[{role:'user',content:'Reply with OK.'}], max_completion_tokens:16, stream:false});
  const choices = result.choices as Array<{message?:{content?:unknown}}> | undefined;
  if (!Array.isArray(choices) || typeof choices[0]?.message?.content !== 'string' || !choices[0].message.content.trim()) throw new HttpError(502, 'model_acceptance_response_invalid');
  return {model, source:'cloudflare', temporaryKeyRevoked:true};
 } finally {
  if (key) {
   try { await call('/key/delete', env.LITELLM_PROVISIONING_KEY, {keys:[key]}); }
   catch { throw new HttpError(502, 'model_acceptance_key_cleanup_failed'); }
  }
 }
}

export const dispatchInstallationRoutes: ApiRouteHandler = async (context, _services, path) => {
 if (path !== 'admin/installation' && path !== 'admin/installation/model-test') return undefined;
 const user = await requireAdminPortalUser(context);
 const db = requireDb(context.env.DB), release = context.env.WORKSPACE_RELEASE ?? 'unversioned';
 const modules = workspaceModulesFromEnv(context.env);
 if (context.request.method === 'GET' && path === 'admin/installation') {
  if (user.identity.authenticationMethod === 'microsoft_entra_id') {
   await db.prepare('INSERT INTO workspace_acceptance(id,kind,release,actor_id,status,started_at,completed_at,detail) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
    .bind(`entra:${release}:${user.id}`, 'entra-login', release, user.id, 'passed', Date.now(), Date.now(), 'Verified Entra session').run();
  }
  const receipts = await db.prepare('SELECT kind,status,started_at AS startedAt,completed_at AS completedAt,detail FROM workspace_acceptance WHERE release = ? ORDER BY started_at DESC LIMIT 20').bind(release).all();
  return json({release,modules,entraConfigured:context.env.WORKSPACE_ENTRA_ENABLED === '1',receipts:receipts.results}, {headers:{'Cache-Control':'no-store'}});
 }
 if (context.request.method !== 'POST' || path !== 'admin/installation/model-test') return json({error:'method_not_allowed'}, {status:405});
 if (context.request.headers.get('Origin') !== new URL(context.env.PORTAL_URL ?? '').origin) throw new HttpError(403,'invalid_request_origin');
 if (!modules.includes('models')) throw new HttpError(404,'module_not_enabled');
 const id = crypto.randomUUID(), now = Date.now();
 const inserted = await db.prepare(`INSERT INTO workspace_acceptance(id,kind,release,actor_id,status,started_at)
 SELECT ?,'model-call',?,?,'running',? WHERE NOT EXISTS(SELECT 1 FROM workspace_acceptance WHERE kind='model-call' AND (started_at > ? OR (status='running' AND started_at > ?)))`)
 .bind(id,release,user.id,now,now-60000,now-300000).run();
 if (!inserted.meta.changes) throw new HttpError(429,'acceptance_test_running_or_recent');
 try {
  const result = await probeModel(context.env,id);
  await db.prepare('UPDATE workspace_acceptance SET status=?,completed_at=?,detail=? WHERE id=?').bind('passed',Date.now(),JSON.stringify(result),id).run();
  return json({passed:true,...result});
 } catch(error) {
  const code = error instanceof HttpError ? error.message : 'model_acceptance_failed';
  await db.prepare('UPDATE workspace_acceptance SET status=?,completed_at=?,detail=? WHERE id=?').bind('failed',Date.now(),code,id).run();
  throw new HttpError(502,code);
 }
};
