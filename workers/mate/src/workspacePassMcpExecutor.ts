import {
  callRuntimeWorkspacePassTool,
  listRuntimeWorkspacePassTools,
  runtimeWorkspacePassWriteRisk,
  type WorkspacePassRuntimeCatalog,
  type WorkspacePassRuntimeTool
} from "./workspacePassMcpClient.ts";
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
import { mateCapacityIncludes, mateForumMcpSelection } from "../../../src/shared/mateMcpCapacity.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimeMode, type RuntimePrincipal } from "./types.ts";

type WorkspacePassMcpOperation = {
  arguments: Record<string, unknown>;
  toolName: string;
  type: "workspace_pass_mcp_tool_call";
};

export function isWorkspacePassMcpOperation(value: unknown) {
  return record(value).type === "workspace_pass_mcp_tool_call";
}

export function canReadOwnMailbox(definition: RuntimeDefinition, principal: RuntimePrincipal, mode: RuntimeMode) {
  return mode === "live" && principal.callerKind === "user"
    && principal.userId === definition.mate.ownerUserId && principal.orgId === definition.mate.orgId
    && Boolean(definition.mate.workEmail);
}

export function isMailboxReadTool(tool: WorkspacePassRuntimeTool) {
  return ["mail_list", "mail_get", "mail_get_attachment"].includes(tool.name) && tool.runtimePolicy.writeMode === "never";
}

export async function executeConversationWorkspacePassRead(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  tool: WorkspacePassRuntimeTool,
  argumentsValue: Record<string, unknown>,
  mode: RuntimeMode,
  signal?: AbortSignal
) {
  if (tool.name.startsWith("mail_") && !canReadOwnMailbox(definition, principal, mode)) {
    throw new RuntimeHttpError(403, "mailbox_access_denied");
  }
  // A provisioned owner mailbox is already scoped by user, org and Mate at
  // the mail service. It does not require granting generic Workspace MCP access.
  if (!isMailboxReadTool(tool) || !canReadOwnMailbox(definition, principal, mode)) assertRuntimeMcpToolScope(definition, tool);
  if (runtimeWorkspacePassWriteRisk(tool, argumentsValue)) {
    throw new RuntimeHttpError(403, "workspace_pass_write_requires_task_approval");
  }
  return callRuntimeWorkspacePassTool(env, principal, tool.name, argumentsValue, { mateId: definition.mate.id, signal });
}

export async function executeWorkspacePassMcpWriteTask(
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
    if (mode === "preview") throw new RuntimeHttpError(409, "preview_workspace_pass_write_not_allowed");
    const operation = workspacePassOperation(input.operation);
    const resolved = await resolveOperation(env, principal, operation);
    assertRuntimeMcpToolScope(definition, resolved.tool);
    const riskLevel = runtimeWorkspacePassWriteRisk(resolved.tool, operation.arguments);
    if (!riskLevel) throw new RuntimeHttpError(400, "workspace_pass_write_operation_invalid");
    const definitionVersion = await toolDefinitionVersion(resolved.catalog, resolved.tool);
    const actionDigest = await operationDigest(definition, operation, definitionVersion);
    const approval = await createApproval(env.RUNTIME_DB, mateId, principal, mode, taskId, {
      actionDigest,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      manifestSha256: definition.release.manifestSha256,
      operation,
      policyVersion: resolved.catalog.catalogVersion,
      releaseId: definition.release.id,
      riskLevel,
      toolDefinitionVersion: definitionVersion
    });
    return { approval, task: await readTask(env.RUNTIME_DB, mateId, principal, mode, taskId) };
  } catch (error) {
    return failedWorkspacePassCall(env, definition, principal, mode, taskId, error);
  }
}

export async function decideAndExecuteWorkspacePassMcpApproval(
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
      failures: [{ approvalId, code: "workspace_pass_action_denied" }],
      followUps: [],
      outcome: "cancelled",
      pendingApprovals: [],
      summary: "Workspace MCP 操作未获当前用户批准，任务已取消。"
    });
    return { approval, task };
  }

  try {
    const operation = workspacePassOperation(approval.operation);
    const task = await readTask(env.RUNTIME_DB, mateId, principal, mode, taskId);
    const resolved = await resolveOperation(env, principal, operation);
    assertRuntimeMcpToolScope(definition, resolved.tool);
    if (!runtimeWorkspacePassWriteRisk(resolved.tool, operation.arguments)) {
      throw new RuntimeHttpError(409, "approval_tool_policy_changed");
    }
    const definitionVersion = await toolDefinitionVersion(resolved.catalog, resolved.tool);
    const actionDigest = await operationDigest(definition, operation, definitionVersion);
    if (
      approval.releaseId !== definition.release.id
      || task.releaseId !== definition.release.id
      || approval.manifestSha256 !== definition.release.manifestSha256
      || approval.toolDefinitionVersion !== definitionVersion
      || approval.policyVersion !== resolved.catalog.catalogVersion
    ) throw new RuntimeHttpError(409, "approval_release_or_tool_changed");
    if (approval.actionDigest !== actionDigest) throw new RuntimeHttpError(409, "approval_action_changed");

    const consumed = await consumeApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId);
    await resumeTaskAfterApproval(env.RUNTIME_DB, mateId, principal, mode, taskId, approvalId);
    const result = await callRuntimeWorkspacePassTool(
      env,
      principal,
      operation.toolName,
      operation.arguments,
      { approved: true, mateId: definition.mate.id }
    );
    const completed = await concludeTask(env.RUNTIME_DB, mateId, principal.userId, mode, taskId, {
      actions: [{ actionDigest, approvalId, toolName: operation.toolName, type: "workspace_pass_mcp" }],
      artifacts: [],
      failures: [],
      followUps: [],
      outcome: "completed",
      pendingApprovals: [],
      summary: `已按当前用户身份完成 Workspace MCP 操作（${operation.toolName}）。`
    });
    return { approval: consumed, result, task: completed };
  } catch (error) {
    try { await consumeApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId); }
    catch { /* A concurrent request may already have consumed this single-use approval. */ }
    const result = await failedWorkspacePassCall(env, definition, principal, mode, taskId, error, approvalId);
    return { ...result, approval: await readApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId) };
  }
}

async function resolveOperation(
  env: RuntimeEnv,
  principal: RuntimePrincipal,
  operation: WorkspacePassMcpOperation
) {
  const catalog = await listRuntimeWorkspacePassTools(env, principal, AbortSignal.timeout(15_000));
  const tool = catalog.tools.find((candidate) => candidate.name === operation.toolName);
  if (!tool) throw new RuntimeHttpError(403, "workspace_pass_tool_not_available");
  return { catalog, tool };
}

function workspacePassOperation(value: unknown): WorkspacePassMcpOperation {
  const operation = record(value);
  const toolName = text(operation.toolName).trim();
  if (
    operation.type !== "workspace_pass_mcp_tool_call"
    || !/^[a-z][a-z0-9_]{0,95}$/.test(toolName)
    || !isRecord(operation.arguments)
  ) throw new RuntimeHttpError(400, "workspace_pass_operation_invalid");
  return {
    arguments: structuredClone(operation.arguments),
    toolName,
    type: "workspace_pass_mcp_tool_call"
  };
}

function assertRuntimeMcpToolScope(definition: RuntimeDefinition, tool: WorkspacePassRuntimeTool) {
  if (tool.capacity) {
    const selection = tool.capacity.group === "forum_hub"
      ? mateForumMcpSelection(definition.release.manifest.resources)
      : definition.release.manifest.resources.mcpCapacity?.ai_capacity;
    if (!mateCapacityIncludes(selection, tool.capacity.child)) {
      throw new RuntimeHttpError(403, "mcp_capacity_not_bound");
    }
    return;
  }
  if (!tool.name.startsWith("mail_") && (!tool.name.startsWith("knowledge_") || tool.runtimePolicy.writeMode !== "never")) {
    throw new RuntimeHttpError(403, "workspace_pass_tool_not_available");
  }
  const scope = definition.release.manifest.resources.workspacePassMcpScope;
  if (
    scope?.mode !== "all_authorized_for_invoking_user"
    || scope.requiresCurrentUserAuthorization !== true
    || scope.authority.mode !== "invoking_user"
    || scope.domains[0] !== "apps"
    || scope.domains[1] !== "knowledge"
  ) throw new RuntimeHttpError(403, "workspace_pass_scope_not_bound");
}

async function toolDefinitionVersion(catalog: WorkspacePassRuntimeCatalog, tool: WorkspacePassRuntimeTool) {
  return `sha256:${await sha256Hex(stableJson({
    catalogVersion: catalog.catalogVersion,
    inputSchema: tool.inputSchema,
    name: tool.name,
    runtimePolicy: tool.runtimePolicy
  }))}`;
}

async function operationDigest(
  definition: RuntimeDefinition,
  operation: WorkspacePassMcpOperation,
  definitionVersion: string
) {
  return `sha256:${await sha256Hex(stableJson({
    manifestSha256: definition.release.manifestSha256,
    operation,
    releaseId: definition.release.id,
    toolDefinitionVersion: definitionVersion
  }))}`;
}

async function failedWorkspacePassCall(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string,
  error: unknown,
  approvalId?: string
) {
  const code = error instanceof RuntimeHttpError ? error.code : "workspace_pass_tool_call_failed";
  const current = await readTask(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId);
  if (["completed", "failed", "cancelled"].includes(String(current.status))) return { task: current };
  return {
    task: await concludeTask(env.RUNTIME_DB, definition.mate.id, principal.userId, mode, taskId, {
      actions: [],
      artifacts: [],
      errorCode: code,
      failures: [{ approvalId, code }],
      followUps: ["检查当前用户实时权限、Workspace MCP 工具状态或审批状态后重试。"],
      outcome: "failed",
      pendingApprovals: [],
      summary: `Mate 未完成 Workspace MCP 操作（${code}）。`
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
