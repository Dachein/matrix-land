import { knowledgeMaintenanceGuidance, validateKnowledgeEditPatch } from "./knowledgeMaintenanceErrors.ts";
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
import {
  executeKnowledgeMaintenanceWrite,
  assertKnowledgeMaintenanceEnabled,
  KNOWLEDGE_MAINTENANCE_WRITE_TOOLS,
  type KnowledgeMaintenanceWriteTool
} from "./knowledgeMaintenanceClient.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimeMode, type RuntimePrincipal } from "./types.ts";

const KNOWLEDGE_MAINTENANCE_TOOL_VERSION = "workspace.knowledge-maintenance/v1";

type KnowledgeMaintenanceOperation = {
  arguments: Record<string, unknown>;
  display?: { fileName: string; path: string };
  toolName: KnowledgeMaintenanceWriteTool;
  type: "workspace_knowledge_maintenance";
};

export function isKnowledgeMaintenanceOperation(value: unknown) {
  return record(value).type === "workspace_knowledge_maintenance";
}

export async function executeKnowledgeMaintenanceTask(
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
    assertKnowledgeMaintenanceBound(definition);
    if (mode === "preview") throw new RuntimeHttpError(409, "preview_knowledge_maintenance_not_allowed");
    const operation = knowledgeMaintenanceOperation(input.operation);
    const actionDigest = await knowledgeMaintenanceActionDigest(definition, operation);
    const approval = await createApproval(env.RUNTIME_DB, mateId, principal, mode, taskId, {
      actionDigest,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      manifestSha256: definition.release.manifestSha256,
      operation,
      policyVersion: "current-user-single-use/v1",
      releaseId: definition.release.id,
      riskLevel: knowledgeMaintenanceRisk(operation),
      toolDefinitionVersion: KNOWLEDGE_MAINTENANCE_TOOL_VERSION
    });
    return { approval, task: await readTask(env.RUNTIME_DB, mateId, principal, mode, taskId) };
  } catch (error) {
    return failedKnowledgeMaintenance(env, definition, principal, mode, taskId, error);
  }
}

export async function decideAndExecuteKnowledgeMaintenanceApproval(
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
      actions: [], artifacts: [], failures: [{ approvalId, code: "knowledge_maintenance_denied" }], followUps: [],
      outcome: "cancelled", pendingApprovals: [], summary: "知识库维护未获当前用户批准，任务已取消。"
    });
    return { approval, task };
  }

  try {
    assertKnowledgeMaintenanceBound(definition);
    const operation = knowledgeMaintenanceOperation(approval.operation);
    const task = await readTask(env.RUNTIME_DB, mateId, principal, mode, taskId);
    const actionDigest = await knowledgeMaintenanceActionDigest(definition, operation);
    if (
      approval.releaseId !== definition.release.id
      || task.releaseId !== definition.release.id
      || approval.manifestSha256 !== definition.release.manifestSha256
      || approval.toolDefinitionVersion !== KNOWLEDGE_MAINTENANCE_TOOL_VERSION
    ) throw new RuntimeHttpError(409, "approval_release_changed");
    if (approval.actionDigest !== actionDigest) throw new RuntimeHttpError(409, "approval_action_changed");

    const consumed = await consumeApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId);
    await resumeTaskAfterApproval(env.RUNTIME_DB, mateId, principal, mode, taskId, approvalId);
    const idempotencyKey = `mate:${taskId}:${actionDigest.slice(-32)}`;
    const argumentsValue = {
      ...operation.arguments,
      ...(operation.toolName === "knowledge_library_delete" ? { confirm: true } : {}),
      idempotencyKey
    };
    const result = await executeKnowledgeMaintenanceWrite(
      env,
      definition,
      principal,
      operation.toolName,
      argumentsValue
    );
    const completed = await concludeTask(env.RUNTIME_DB, mateId, principal.userId, mode, taskId, {
      actions: [{ actionDigest, approvalId, toolName: operation.toolName, type: "knowledge.maintenance.completed" }],
      artifacts: [], failures: [], followUps: [], outcome: "completed", pendingApprovals: [],
      summary: `已按当前用户身份完成知识库维护操作（${operation.toolName}）。`
    });
    return { approval: consumed, result, task: completed };
  } catch (error) {
    try { await consumeApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId); }
    catch { /* Approval may already have been consumed by another request. */ }
    const result = await failedKnowledgeMaintenance(env, definition, principal, mode, taskId, error, approvalId);
    return { ...result, approval: await readApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId) };
  }
}

function knowledgeMaintenanceOperation(value: unknown): KnowledgeMaintenanceOperation {
  const operation = record(value);
  const toolName = text(operation.toolName) as KnowledgeMaintenanceWriteTool;
  if (
    operation.type !== "workspace_knowledge_maintenance"
    || !KNOWLEDGE_MAINTENANCE_WRITE_TOOLS.includes(toolName)
    || !isRecord(operation.arguments)
  ) throw new RuntimeHttpError(400, "knowledge_maintenance_operation_invalid");
  const argumentsValue = { ...operation.arguments };
  delete argumentsValue.confirm;
  delete argumentsValue.confirmation;
  delete argumentsValue.idempotencyKey;
  if (toolName === "knowledge_library_write") {
    const action = text(argumentsValue.action);
    if (![
      "upload", "update", "edit", "batch", "create_folder", "rename", "move", "restore", "restore_version"
    ].includes(action)) throw new RuntimeHttpError(400, "knowledge_maintenance_action_invalid");
  }
  if (toolName === "knowledge_library_write" && argumentsValue.action === "edit") validateKnowledgeEditPatch(argumentsValue);
  if (toolName === "knowledge_library_write" && argumentsValue.action === "batch" && Array.isArray(argumentsValue.items)) {
    for (const item of argumentsValue.items) validateKnowledgeEditPatch(record(item));
  }
  // Display metadata is stored with, and bound to, the exact approved operation.
  // It is never forwarded as a write argument. Legacy approvals omit it entirely.
  const display = isRecord(operation.display) ? {
    fileName: text(operation.display.fileName).slice(0, 240),
    path: text(operation.display.path).slice(0, 2048)
  } : undefined;
  return { arguments: argumentsValue, ...(display ? { display } : {}), toolName, type: "workspace_knowledge_maintenance" };
}

function knowledgeMaintenanceRisk(operation: KnowledgeMaintenanceOperation): "medium" | "high" {
  const action = text(operation.arguments.action);
  return operation.toolName === "knowledge_library_delete"
    || ["update", "edit", "batch", "restore_version"].includes(action)
    ? "high"
    : "medium";
}

async function knowledgeMaintenanceActionDigest(definition: RuntimeDefinition, operation: KnowledgeMaintenanceOperation) {
  const payload = stableJson({
    manifestSha256: definition.release.manifestSha256,
    operation,
    releaseId: definition.release.id,
    toolDefinitionVersion: KNOWLEDGE_MAINTENANCE_TOOL_VERSION
  });
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)));
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function failedKnowledgeMaintenance(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string,
  error: unknown,
  approvalId?: string
) {
  const code = error instanceof RuntimeHttpError ? error.code : "knowledge_maintenance_failed";
  const current = await readTask(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId);
  if (["completed", "failed", "cancelled"].includes(String(current.status))) return { task: current };
  return {
    task: await concludeTask(env.RUNTIME_DB, definition.mate.id, principal.userId, mode, taskId, {
      actions: [], artifacts: [], errorCode: code, failures: [{ approvalId, code, ...(error instanceof RuntimeHttpError ? error.details : {}) }],
      followUps: [knowledgeMaintenanceGuidance(code)],
      outcome: "failed", pendingApprovals: [], summary: `Mate 未完成知识库维护（${code}）。${knowledgeMaintenanceGuidance(code)}`
    })
  };
}

function assertKnowledgeMaintenanceBound(definition: RuntimeDefinition) {
  assertKnowledgeMaintenanceEnabled(definition);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
