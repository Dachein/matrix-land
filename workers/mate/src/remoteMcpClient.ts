import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimePrincipal } from './types.ts';

export type RemoteRuntimeTool = { name: string; description?: string; inputSchema: Record<string, unknown>; digest: string; readOnly: boolean };
export type RemoteRuntimeConnection = { id: string; name: string; generation: number; tools: RemoteRuntimeTool[]; unavailable?: boolean };
export type RemoteOperation = { type: 'remote_mcp_tool_call'; connectionId: string; generation: number; toolName: string; digest: string; arguments: Record<string, unknown> };
async function bridge(env: RuntimeEnv, principal: RuntimePrincipal, mateId: string, path: string, input: Record<string, unknown>, signal?: AbortSignal) {
  if (!env.AUTH_SERVICE || !env.MATE_MCP_SERVICE_TOKEN) throw new RuntimeHttpError(503, 'remote_mcp_not_configured');
  const response = await env.AUTH_SERVICE.fetch(new Request(`https://auth.internal/v1/internal/remote-mcp/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MATE_MCP_SERVICE_TOKEN}` },
    body: JSON.stringify({ ...input, userId: principal.userId, orgId: principal.orgId, mateId }), signal
  }));
  const payload = await response.json() as { error?: string; connections?: RemoteRuntimeConnection[]; result?: unknown };
  if (!response.ok) throw new RuntimeHttpError(response.status, payload.error || 'remote_mcp_failed');
  return payload;
}
export async function listRemoteRuntimeTools(env: RuntimeEnv, principal: RuntimePrincipal, mateId: string, signal?: AbortSignal) {
  if (env.REMOTE_MCP_ENABLED !== '1') return [];
  return (await bridge(env, principal, mateId, 'tools', {}, signal)).connections || [];
}
export async function callRemoteRuntimeTool(env: RuntimeEnv, principal: RuntimePrincipal, mateId: string, operation: RemoteOperation, approved = false, signal?: AbortSignal) {
  if (env.REMOTE_MCP_ENABLED !== '1') throw new RuntimeHttpError(503, 'remote_mcp_not_configured');
  const result = (await bridge(env, principal, mateId, 'call', { ...operation, approved }, signal)).result;
  if (result && typeof result === 'object' && (result as { isError?: boolean }).isError) throw new RuntimeHttpError(502, 'remote_mcp_tool_failed');
  return result;
}
export async function resolveRemoteOperation(env: RuntimeEnv, principal: RuntimePrincipal, mateId: string, operation: RemoteOperation) {
  const connections = await listRemoteRuntimeTools(env, principal, mateId, AbortSignal.timeout(30_000));
  const connection = connections.find(c => c.id === operation.connectionId && c.generation === operation.generation);
  const tool = connection?.tools.find(t => t.name === operation.toolName && t.digest === operation.digest);
  if (!connection || !tool) throw new RuntimeHttpError(409, 'remote_mcp_tool_changed');
  return { connection, tool };
}
export async function manageRemoteMcp(env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal,
  input: Record<string, unknown>, approved = false) {
  if (principal.callerKind !== 'user' || principal.userId !== definition.mate.ownerUserId
    || principal.orgId !== definition.mate.orgId) throw new RuntimeHttpError(403, 'mate_owner_required');
  if (env.REMOTE_MCP_ENABLED !== '1') throw new RuntimeHttpError(503, 'remote_mcp_not_configured');
  return bridge(env, principal, definition.mate.id, 'manage', { ...input, approved }, AbortSignal.timeout(90_000)) as Promise<Record<string, any>>;
}
