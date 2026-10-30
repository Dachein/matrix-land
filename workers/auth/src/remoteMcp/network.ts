import { HttpError, type Env } from '../types.ts';

// Each provider's MCP and OAuth hosts are approved together by the operator.
// Arbitrary user-controlled metadata must never expand this egress policy.
export function remoteUrl(raw: string, env: Env) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, 'remote_mcp_url_invalid'); }
  const hosts = (env.REMOTE_MCP_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase());
  if (raw.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.hash
    || (url.port && url.port !== '443') || url.hostname.includes(':') || /^[\d.]+$/.test(url.hostname)
    || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || !hosts.includes(url.hostname.toLowerCase()))
    throw new HttpError(400, 'remote_mcp_host_not_allowed');
  return url.toString();
}

export async function remoteFetch(env: Env, url: string, init: RequestInit = {}) {
  try {
    // Workers supports manual/follow only. Reject redirects before any second
    // request so MCP credentials never leave the approved endpoint.
    const response = await fetch(remoteUrl(url, env), { ...init, redirect: 'manual', signal: AbortSignal.timeout(25000) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new HttpError(502, 'remote_mcp_redirect_not_allowed');
    }
    return response;
  }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'remote_mcp_network_failed');
  }
}

export async function boundedText(response: Response, maximum = 2_000_000) {
  if (!response.body) throw new HttpError(502, 'remote_mcp_empty_response');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, result = '';
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw new HttpError(502, 'remote_mcp_response_too_large');
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

export async function remoteJson(env: Env, url: string, init?: RequestInit) {
  const response = await remoteFetch(env, url, init);
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(response.status === 401 || response.status === 400 ? 401 : 502, 'remote_mcp_oauth_request_failed');
  }
  try { return JSON.parse(await boundedText(response, 256_000)) as Record<string, any>; }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, 'remote_mcp_metadata_invalid'); }
}
