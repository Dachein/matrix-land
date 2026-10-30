import { callRemoteRuntimeTool, resolveRemoteOperation, type RemoteOperation } from './remoteMcpClient.ts';
import {
  concludeTask,
  consumeApproval,
  createApproval,
  decideApproval,
  readApproval,
  readTask,
  resumeTaskAfterApproval,
  startTask
} from "./storage.ts";

import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimeMode, type RuntimePrincipal } from "./types.ts";

export function isRemoteMcpOperation(value: unknown) { return record(value).type === 'remote_mcp_tool_call'; }

export async function executeRemoteMcpWriteTask(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string,
  input: Record<string, unknown>
) {
  const mateId = definition.mate.id;
  await startTask(env.RUNTIME_DB, mateId, principal, mode, taskId, definition.release.id);
  try {
    if (mode === "preview") throw new RuntimeHttpError(409, "preview_remote_mcp_write_not_allowed");
    const operation = remoteOperation(input.operation);
    const resolved = await resolveRemoteOperation(env, principal, mateId, operation);

    const riskLevel = (resolved.tool.readOnly ? undefined : 'high');
    if (!riskLevel) throw new RuntimeHttpError(400, "remote_mcp_write_operation_invalid");
    const definitionVersion = `${operation.generation}:${operation.digest}`;
    const actionDigest = await operationDigest(definition, operation, definitionVersion);
    const approval = await createApproval(env.RUNTIME_DB, mateId, principal, mode, taskId, {
      actionDigest,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      manifestSha256: definition.release.manifestSha256,
      operation,
      policyVersion: 'remote-mcp/v1',
      releaseId: definition.release.id,
      riskLevel,
      toolDefinitionVersion: definitionVersion
    });
    return { approval, task: await readTask(env.RUNTIME_DB, mateId, principal, mode, taskId) };
  } catch (error) {
    return failedRemoteMcpCall(env, definition, principal, mode, taskId, error);
  }
}

export async function decideAndExecuteRemoteMcpApproval(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  approvalId: string,
  decision: unknown
) {
  const mateId = definition.mate.id;
  const approval = await decideApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId, decision);
  const taskId = text(approval.taskId);
  if (approval.status === "denied") {
    const task = await concludeTask(env.RUNTIME_DB, mateId, principal.userId, mode, taskId, {
      actions: [],
      artifacts: [],
      failures: [{ approvalId, code: "remote_mcp_action_denied" }],
      followUps: [],
      outcome: "cancelled",
      pendingApprovals: [],
      summary: "第三方 MCP 操作未获当前用户批准，任务已取消。"
    });
    return { approval, task };
  }

  try {
    const operation = remoteOperation(approval.operation);
    const task = await readTask(env.RUNTIME_DB, mateId, principal, mode, taskId);
    const resolved = await resolveRemoteOperation(env, principal, mateId, operation);

    if (!(resolved.tool.readOnly ? undefined : 'high')) {
      throw new RuntimeHttpError(409, "approval_tool_policy_changed");
    }
    const definitionVersion = `${operation.generation}:${operation.digest}`;
    const actionDigest = await operationDigest(definition, operation, definitionVersion);
    if (
      approval.releaseId !== definition.release.id
      || task.releaseId !== definition.release.id
      || approval.manifestSha256 !== definition.release.manifestSha256
      || approval.toolDefinitionVersion !== definitionVersion
      || approval.policyVersion !== 'remote-mcp/v1'
    ) throw new RuntimeHttpError(409, "approval_release_or_tool_changed");
    if (approval.actionDigest !== actionDigest) throw new RuntimeHttpError(409, "approval_action_changed");

    const consumed = await consumeApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId);
    await resumeTaskAfterApproval(env.RUNTIME_DB, mateId, principal, mode, taskId, approvalId);
    const result = await callRemoteRuntimeTool(env, principal, mateId, operation, true);
    const completed = await concludeTask(env.RUNTIME_DB, mateId, principal.userId, mode, taskId, {
      actions: [{ actionDigest, approvalId, toolName: operation.toolName, type: "remote_mcp" }],
      artifacts: [],
      failures: [],
      followUps: [],
      outcome: "completed",
      pendingApprovals: [],
      summary: `已按当前用户身份完成 第三方 MCP 操作（${operation.toolName}）。`
    });
    return { approval: consumed, result, task: completed };
  } catch (error) {
    try { await consumeApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId); }
    catch { /* A concurrent request may already have consumed this single-use approval. */ }
    const result = await failedRemoteMcpCall(env, definition, principal, mode, taskId, error, approvalId);
    return { ...result, approval: await readApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId) };
  }
}

function remoteOperation(value: unknown): RemoteOperation {
  const operation = record(value);
  if (operation.type !== 'remote_mcp_tool_call' || typeof operation.connectionId !== 'string'
    || typeof operation.generation !== 'number' || typeof operation.digest !== 'string'
    || typeof operation.toolName !== 'string' || !isRecord(operation.arguments))
    throw new RuntimeHttpError(400, 'remote_mcp_operation_invalid');
  return structuredClone(operation) as RemoteOperation;
}

async function operationDigest(
  definition: RuntimeDefinition,
  operation: RemoteOperation,
  definitionVersion: string
) {
  return `sha256:${await sha256Hex(stableJson({
    manifestSha256: definition.release.manifestSha256,
    operation,
    releaseId: definition.release.id,
    toolDefinitionVersion: definitionVersion
  }))}`;
}

async function failedRemoteMcpCall(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string,
  error: unknown,
  approvalId?: string
) {
  const code = error instanceof RuntimeHttpError ? error.code : "remote_mcp_tool_call_failed";
  const current = await readTask(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId);
  if (["completed", "failed", "cancelled"].includes(String(current.status))) return { task: current };
  return {
    task: await concludeTask(env.RUNTIME_DB, definition.mate.id, principal.userId, mode, taskId, {
      actions: [],
      artifacts: [],
      errorCode: code,
      failures: [{ approvalId, code }],
      followUps: ["检查当前用户实时权限、第三方 MCP 工具状态或审批状态后重试。"],
      outcome: "failed",
      pendingApprovals: [],
      summary: `Mate 未完成 第三方 MCP 操作（${code}）。`
    })
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${stableJson(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256Hex(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
