import { z } from 'zod';
import { manageRemoteMcp } from './remoteMcpClient.ts';
import { remoteMcpToolChoiceSchema } from './remoteMcpToolChoice.ts';
import { concludeTask, consumeApproval, createApproval, decideApproval, readApproval, readTask, resumeTaskAfterApproval, startTask } from './storage.ts';
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimeMode, type RuntimePrincipal } from './types.ts';

const schema = z.strictObject({
  type: z.literal('remote_mcp_plugin_change'), action: z.enum(['enable', 'disable', 'remove']),
  connectionId: z.string().min(1).max(160), generation: z.number().int().nonnegative(),
  tools: z.array(remoteMcpToolChoiceSchema).max(64).optional()
});
export function isPluginOperation(value: unknown) { return record(value).type === 'remote_mcp_plugin_change'; }
function parse(value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success || (result.data.action === 'enable' && !result.data.tools?.length))
    throw new RuntimeHttpError(400, 'mate_plugin_change_invalid');
  return result.data;
}
async function inspect(env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal, operation: z.infer<typeof schema>) {
  const listing = await manageRemoteMcp(env, definition, principal, { action: 'list' });
  const connection = listing.connections?.find((row: any) => row.id === operation.connectionId && row.generation === operation.generation);
  if (!connection) throw new RuntimeHttpError(409, 'remote_mcp_connection_changed');
  if (operation.action === 'enable') {
    const tested = await manageRemoteMcp(env, definition, principal, { action: 'test', connectionId: operation.connectionId });
    if (tested.connection.generation !== operation.generation || operation.tools!.some(choice =>
      !tested.tools.some((tool: any) => tool.name === choice.name && tool.digest === choice.digest)))
      throw new RuntimeHttpError(409, 'remote_mcp_tool_changed');
  }
  return connection;
}
async function digest(definition: RuntimeDefinition, operation: z.infer<typeof schema>) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({
    operation, releaseId: definition.release.id, manifest: definition.release.manifestSha256, policy: 'owner-plugin/v1'
  }))));
  return `sha256:${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}
export async function proposePluginTask(env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal, mode: RuntimeMode, taskId: string, input: unknown) {
  await startTask(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId, definition.release.id);
  try {
    if (mode !== 'live') throw new RuntimeHttpError(409, 'preview_plugin_management_not_allowed');
    const operation = parse(input);
    await inspect(env, definition, principal, operation);
    const approval = await createApproval(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId, {
      operation, actionDigest: await digest(definition, operation), releaseId: definition.release.id,
      manifestSha256: definition.release.manifestSha256, toolDefinitionVersion: 'mate-plugins/v1',
      policyVersion: 'owner-plugin/v1', riskLevel: 'high', expiresAt: new Date(Date.now() + 600_000).toISOString()
    });
    return { approval, task: await readTask(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId) };
  } catch (error) { return failed(env, definition, principal, mode, taskId, error); }
}
export async function decideAndExecutePluginApproval(env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal, mode: RuntimeMode, approvalId: string, decision: unknown) {
  const approval = await decideApproval(env.RUNTIME_DB, definition.mate.id, principal, mode, approvalId, decision);
  const taskId = String(approval.taskId);
  if (approval.status === 'denied') return { approval, task: await concludeTask(env.RUNTIME_DB, definition.mate.id, principal.userId, mode, taskId, {
    actions: [], artifacts: [], failures: [], followUps: [], pendingApprovals: [], outcome: 'cancelled', summary: 'Owner 取消了插件变更。'
  }) };
  try {
    if (mode !== 'live') throw new RuntimeHttpError(409, 'preview_plugin_management_not_allowed');
    const operation = parse(approval.operation);
    const task = await readTask(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId);
    if (approval.releaseId !== definition.release.id || task.releaseId !== definition.release.id
      || approval.manifestSha256 !== definition.release.manifestSha256 || approval.toolDefinitionVersion !== 'mate-plugins/v1'
      || approval.policyVersion !== 'owner-plugin/v1' || approval.actionDigest !== await digest(definition, operation))
      throw new RuntimeHttpError(409, 'approval_release_or_action_changed');
    await inspect(env, definition, principal, operation);
    const consumed = await consumeApproval(env.RUNTIME_DB, definition.mate.id, principal, mode, approvalId);
    await resumeTaskAfterApproval(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId, approvalId);
    const result = await manageRemoteMcp(env, definition, principal, operation, true);
    return { approval: consumed, result, task: await concludeTask(env.RUNTIME_DB, definition.mate.id, principal.userId, mode, taskId, {
      actions: [{ type: 'mate.plugin.updated', action: operation.action, connectionId: operation.connectionId, approvalId }],
      artifacts: [], failures: [], followUps: [], pendingApprovals: [], outcome: 'completed', summary: `插件变更已完成（${operation.action}）。`
    }) };
  } catch (error) {
    try { await consumeApproval(env.RUNTIME_DB, definition.mate.id, principal, mode, approvalId); } catch { /* single use */ }
    return { ...await failed(env, definition, principal, mode, taskId, error), approval: await readApproval(env.RUNTIME_DB, definition.mate.id, principal, mode, approvalId) };
  }
}
async function failed(env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal, mode: RuntimeMode, taskId: string, error: unknown) {
  const code = error instanceof RuntimeHttpError ? error.code : 'mate_plugin_change_failed';
  return { task: await concludeTask(env.RUNTIME_DB, definition.mate.id, principal.userId, mode, taskId, {
    actions: [], artifacts: [], failures: [{ code }], errorCode: code, followUps: [], pendingApprovals: [], outcome: 'failed', summary: `插件变更未完成（${code}）。`
  }) };
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
