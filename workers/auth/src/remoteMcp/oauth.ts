import { authPublicUrl } from '../configuration.ts';
import { randomBase64Url, sha256 } from '../crypto.ts';
import { HttpError, type Env } from '../types.ts';
import { remoteJson, remoteUrl } from './network.ts';

export type OAuthContext = {
  mateId?: string; conversationId?: string; resource: string; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; revocationEndpoint?: string;
  clientId: string; clientSecret?: string; authMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
  verifier: string; state: string; redirectUri: string; scope?: string;
};
export type RemoteCredential = { oauth?: OAuthContext; accessToken?: string; refreshToken?: string; expiresAt: number };
export function remoteCallback(env: Env) { return `${new URL(authPublicUrl(env)).origin}/auth/remote-mcp/callback`; }
export function remoteClientMetadata(env: Env) {
  return { client_id: `${new URL(authPublicUrl(env)).origin}/auth/remote-mcp/client-metadata.json`, client_name: 'Mate',
    redirect_uris: [remoteCallback(env)], grant_types: ['authorization_code','refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
}
const sameUrl = (a: string, b: string) => { try { return new URL(a).toString().replace(/\/$/, '') === new URL(b).toString().replace(/\/$/, ''); } catch { return false; } };

export async function discoverRemoteOAuth(env: Env, resource: string, challenge: string): Promise<OAuthContext> {
  const url = new URL(resource);
  const advertised = /\bresource_metadata="([^"]+)"/.exec(challenge)?.[1];
  const candidates = advertised ? [advertised] : [
    `${url.origin}/.well-known/oauth-protected-resource${url.pathname === '/' ? '' : url.pathname}`,
    `${url.origin}/.well-known/oauth-protected-resource`
  ];
  let protectedResource: Record<string, any> | undefined;
  for (const candidate of [...new Set(candidates)]) {
    try { protectedResource = await remoteJson(env, candidate); break; }
    catch (error) { if (advertised || (error instanceof HttpError && error.status === 400)) throw error; }
  }
  if (!protectedResource || !sameUrl(String(protectedResource.resource), resource)
    || !Array.isArray(protectedResource.authorization_servers) || !protectedResource.authorization_servers.length)
    throw new HttpError(502, 'remote_mcp_resource_metadata_invalid');
  const issuer = remoteUrl(protectedResource.authorization_servers[0], env), issuerUrl = new URL(issuer);
  if (issuerUrl.search) throw new HttpError(502, 'remote_mcp_issuer_invalid');
  const issuerPath = issuerUrl.pathname.replace(/\/$/, '');
  const discovery = [`${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
    ...(issuerPath ? [`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`] : [])];
  let metadata: Record<string, any> | undefined;
  for (const endpoint of discovery) {
    try { metadata = await remoteJson(env, endpoint); break; }
    catch (error) { if (error instanceof HttpError && error.status === 400) throw error; }
  }
  if (!metadata || !sameUrl(String(metadata.issuer), issuer) || !metadata.code_challenge_methods_supported?.includes('S256')
    || !metadata.response_types_supported?.includes('code')) throw new HttpError(502, 'remote_mcp_oauth_metadata_invalid');
  const authorizationEndpoint = remoteUrl(metadata.authorization_endpoint, env), tokenEndpoint = remoteUrl(metadata.token_endpoint, env);
  const registered = env.REMOTE_MCP_CLIENTS_JSON ? JSON.parse(env.REMOTE_MCP_CLIENTS_JSON)[resource] : undefined;
  let clientId = '', clientSecret: string | undefined, authMethod: OAuthContext['authMethod'] = 'none';
  if (registered) {
    clientId = registered.client_id; clientSecret = registered.client_secret;
    authMethod = registered.token_endpoint_auth_method || (clientSecret ? 'client_secret_basic' : 'none');
  } else if (metadata.client_id_metadata_document_supported === true) {
    clientId = remoteClientMetadata(env).client_id;
  } else if (metadata.registration_endpoint) {
    const registration = await remoteJson(env, remoteUrl(metadata.registration_endpoint, env), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...remoteClientMetadata(env), client_id: undefined })
    });
    clientId = registration.client_id; clientSecret = registration.client_secret;
    authMethod = registration.token_endpoint_auth_method || 'none';
    if (!registration.redirect_uris?.includes(remoteCallback(env))) throw new HttpError(502, 'remote_mcp_registration_invalid');
  } else throw new HttpError(409, 'remote_mcp_client_registration_required');
  if (typeof clientId !== 'string' || !clientId || clientId.length > 2048 || !['none','client_secret_basic','client_secret_post'].includes(authMethod)
    || (authMethod !== 'none' && typeof clientSecret !== 'string')
    || (metadata.token_endpoint_auth_methods_supported && !metadata.token_endpoint_auth_methods_supported.includes(authMethod)))
    throw new HttpError(502, 'remote_mcp_client_invalid');
  const challengedScope = /\bscope="([^"]+)"/.exec(challenge)?.[1];
  const scope = challengedScope || (Array.isArray(protectedResource.scopes_supported) ? protectedResource.scopes_supported.join(' ') : undefined);
  if (scope && (scope.length > 2048 || /[\r\n]/.test(scope))) throw new HttpError(502, 'remote_mcp_scope_invalid');
  return { resource, issuer, authorizationEndpoint, tokenEndpoint, clientId, clientSecret, authMethod,
    revocationEndpoint: metadata.revocation_endpoint ? remoteUrl(metadata.revocation_endpoint, env) : undefined,
    verifier: randomBase64Url(32), state: randomBase64Url(32), redirectUri: remoteCallback(env), scope };
}

export async function remoteAuthorizationUrl(context: OAuthContext) {
  const url = new URL(context.authorizationEndpoint);
  const parameters = { client_id: context.clientId, response_type: 'code', redirect_uri: context.redirectUri,
    state: context.state, code_challenge: await sha256(context.verifier), code_challenge_method: 'S256', resource: context.resource,
    ...(context.scope ? { scope: context.scope } : {}) };
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
}

export async function exchangeRemoteToken(env: Env, context: OAuthContext, parameters: Record<string, string>, oldRefreshToken = ''): Promise<RemoteCredential> {
  const body = new URLSearchParams({ ...parameters, resource: context.resource });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (context.authMethod === 'client_secret_basic') {
    const encode = (value: string) => new URLSearchParams({ x: value }).toString().slice(2);
    headers.Authorization = `Basic ${btoa(`${encode(context.clientId)}:${encode(context.clientSecret!)}`)}`;
  } else {
    body.set('client_id', context.clientId);
    if (context.authMethod === 'client_secret_post') body.set('client_secret', context.clientSecret!);
  }
  const result = await remoteJson(env, context.tokenEndpoint, { method: 'POST', headers, body });
  if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 32768
    || (result.token_type && String(result.token_type).toLowerCase() !== 'bearer')
    || (result.expires_in !== undefined && (!Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0)))
    throw new HttpError(502, 'remote_mcp_token_invalid');
  return { oauth: { ...context, verifier: '', state: '' }, accessToken: result.access_token,
    refreshToken: typeof result.refresh_token === 'string' ? result.refresh_token : oldRefreshToken,
    expiresAt: result.expires_in === undefined ? 8640000000000000 : Date.now() + Number(result.expires_in) * 1000 };
}
