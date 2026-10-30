import { HttpError, type Env } from '../types.ts';
import { remoteFetch } from './network.ts';

export type RemoteTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } };
export class RemoteAuthorizationRequired extends HttpError {
  challenge: string;
  constructor(challenge: string) { super(401, 'remote_mcp_authorization_required'); this.challenge = challenge; }
}
type Rpc = { jsonrpc?: string; id?: string | number; result?: any; error?: unknown };

async function rpcResponse(response: Response, id: string): Promise<any> {
  if (!response.body) throw new HttpError(502, 'remote_mcp_empty_response');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const sse = response.headers.get('content-type')?.includes('text/event-stream');
  let size = 0, buffer = '', data: string[] = [];
  const parse = (value: string): Rpc => {
    try { return JSON.parse(value); } catch { throw new HttpError(502, 'remote_mcp_response_invalid'); }
  };
  const result = (message: Rpc) => {
    if (message.jsonrpc !== '2.0' || message.id !== id) return undefined;
    if (message.error || !Object.hasOwn(message, 'result')) throw new HttpError(502, 'remote_mcp_rpc_failed');
    return { value: message.result };
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (!chunk.done) {
        size += chunk.value.byteLength;
        if (size > 2_000_000) throw new HttpError(502, 'remote_mcp_response_too_large');
        buffer += decoder.decode(chunk.value, { stream: true });
      } else buffer += decoder.decode();
      if (sse) {
        // Read a response from a long-lived SSE stream without waiting for EOF.
        buffer = buffer.replace(/\r\n/g, '\n');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          else if (!line && data.length) {
            const resolved = result(parse(data.join('\n'))); data = [];
            if (resolved) return resolved.value;
          }
        }
      } else if (chunk.done) {
        const resolved = result(parse(buffer));
        if (resolved) return resolved.value;
      }
      if (chunk.done) throw new HttpError(502, 'remote_mcp_response_missing');
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function withRemoteMcp<T>(env: Env, serverUrl: string, accessToken: string | undefined,
  execute: (rpc: (method: string, params?: Record<string, unknown>) => Promise<any>) => Promise<T>) {
  let session = '', version = '2025-11-25';
  const headers = () => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...(session ? { 'Mcp-Session-Id': session } : {}), 'MCP-Protocol-Version': version });
  const rpc = async (method: string, params?: Record<string, unknown>, notification = false) => {
    const id = crypto.randomUUID();
    const response = await remoteFetch(env, serverUrl, { method: 'POST', headers: headers(),
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }) });
    if (response.status === 401) {
      const challenge = response.headers.get('WWW-Authenticate') || ''; await response.body?.cancel();
      throw new RemoteAuthorizationRequired(challenge);
    }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'remote_mcp_http_failed'); }
    if (notification) { await response.body?.cancel(); return; }
    const serverSession = response.headers.get('mcp-session-id');
    if (serverSession) {
      if (serverSession.length > 512 || /[\r\n]/.test(serverSession)) throw new HttpError(502, 'remote_mcp_session_invalid');
      session = serverSession;
    }
    return rpcResponse(response, id);
  };
  try {
    const initialized = await rpc('initialize', { protocolVersion: version, capabilities: {},
      clientInfo: { name: 'Mate', version: '1.0.0' } });
    if (!['2025-11-25','2025-06-18','2025-03-26','2024-11-05'].includes(initialized?.protocolVersion))
      throw new HttpError(502, 'remote_mcp_protocol_unsupported');
    version = initialized.protocolVersion;
    await rpc('notifications/initialized', undefined, true);
    return await execute(rpc);
  } finally {
    if (session) await remoteFetch(env, serverUrl, { method: 'DELETE', headers: headers() })
      .then(response => response.body?.cancel()).catch(() => {});
  }
}

export async function listRemoteTools(rpc: (method: string, params?: Record<string, unknown>) => Promise<any>): Promise<RemoteTool[]> {
  let cursor: string | undefined, pages = 0;
  const tools: RemoteTool[] = [], names = new Set<string>(), cursors = new Set<string>();
  do {
    if (++pages > 16) throw new HttpError(502, 'remote_mcp_tools_limit');
    const response = await rpc('tools/list', cursor ? { cursor } : {});
    if (!Array.isArray(response?.tools)) throw new HttpError(502, 'remote_mcp_tools_invalid');
    for (const value of response.tools) {
      if (!value || typeof value.name !== 'string' || !/^[\w.-]{1,128}$/.test(value.name)
        || names.has(value.name) || !value.inputSchema || value.inputSchema.type !== 'object'
        || JSON.stringify(value).length > 24_000 || (value.description && typeof value.description !== 'string'))
        throw new HttpError(502, 'remote_mcp_tools_invalid');
      names.add(value.name); tools.push(value);
    }
    if (tools.length > 64) throw new HttpError(502, 'remote_mcp_tools_limit');
    cursor = response.nextCursor;
    if (cursor && (typeof cursor !== 'string' || cursor.length > 2048 || cursors.has(cursor)))
      throw new HttpError(502, 'remote_mcp_cursor_invalid');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return tools;
}
