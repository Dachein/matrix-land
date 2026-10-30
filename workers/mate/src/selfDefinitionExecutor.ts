import type { OwnerMateDefinitionChange } from "../../apps/src/mates/service.ts";
import { z } from "zod";
import {
  concludeTask, consumeApproval, createApproval, decideApproval, readApproval,
  readTask, resumeTaskAfterApproval, startTask
} from "./storage.ts";
import { applySelfDefinition, reviewSelfDefinition } from "./selfDefinitionClient.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimeMode, type RuntimePrincipal } from "./types.ts";

const TOOL_VERSION = "mate-self-definition/v1";
type SelfDefinitionOperation = { type: "mate_self_definition_update"; change: OwnerMateDefinitionChange };
const changeSchema = z.strictObject({
  expectedDraftRevision: z.number().int().positive(),
  expectedReleaseId: z.string().min(1).max(128),
  mail: z.string().max(24000).optional(),
  inboxPrompt: z.string().max(24000).optional(),
  soul: z.string().min(1).max(120_000).optional(),
  handbook: z.string().min(1).max(240_000).optional(),
  builtInToolIds: z.array(z.string().min(1).max(80)).max(32).optional(),
  mcpCapacity: z.unknown().optional(),
  skill: z.strictObject({
    skillId: z.string().min(1).max(120).optional(),
    skillMarkdown: z.string().min(1).max(200_000),
    version: z.string().min(1).max(64),
    files: z.array(z.strictObject({ path: z.string().min(1).max(512), content: z.string().max(200_000) })).max(64).optional()
  }).optional(),
  installSkill: z.strictObject({ skillId: z.string().min(1).max(120), version: z.string().min(1).max(64), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).optional(),
  removeSkillIds: z.array(z.string().min(1).max(120)).min(1).max(64).optional()
}).refine((value) => value.mail !== undefined || value.inboxPrompt !== undefined || value.soul !== undefined || value.handbook !== undefined
  || value.builtInToolIds !== undefined || value.mcpCapacity !== undefined || value.skill !== undefined
  || value.installSkill !== undefined || value.removeSkillIds !== undefined);

export function isSelfDefinitionOperation(value: unknown) {
  return record(value).type === "mate_self_definition_update";
}

export async function proposeSelfDefinitionTask(
  env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal,
  mode: RuntimeMode, taskId: string, change: OwnerMateDefinitionChange
) {
  await startTask(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId, definition.release.id);
  try {
    if (mode !== "live") throw new RuntimeHttpError(409, "preview_self_definition_not_allowed");
    change = parseChange(change);
    const review = await reviewSelfDefinition(env, definition, principal);
    if (review.hasUnpublishedChanges === true) throw new RuntimeHttpError(409, 'mate_unpublished_draft_changes');
    if (review.activeReleaseId !== change.expectedReleaseId || review.draftRevision !== change.expectedDraftRevision
      || change.expectedReleaseId !== definition.release.id) {
      throw new RuntimeHttpError(409, "mate_definition_changed");
    }
    const operation: SelfDefinitionOperation = { type: "mate_self_definition_update", change };
    const actionDigest = await digest(definition, operation);
    const approval = await createApproval(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId, {
      actionDigest,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      manifestSha256: definition.release.manifestSha256,
      operation,
      policyVersion: "owner-single-use/v1",
      releaseId: definition.release.id,
      riskLevel: "high",
      toolDefinitionVersion: TOOL_VERSION
    });
    return { approval, task: await readTask(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId) };
  } catch (error) {
    return failed(env, definition, principal, mode, taskId, error);
  }
}

export async function decideAndExecuteSelfDefinitionApproval(
  env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal,
  mode: RuntimeMode, approvalId: string, decision: unknown
) {
  const mateId = definition.mate.id;
  const approval = await decideApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId, decision);
  const taskId = String(approval.taskId);
  if (approval.status === "denied") {
    const task = await concludeTask(env.RUNTIME_DB, mateId, principal.userId, mode, taskId, {
      actions: [], artifacts: [], failures: [{ approvalId, code: "mate_definition_denied" }],
      followUps: [], outcome: "cancelled", pendingApprovals: [], summary: "Owner 未批准 Mate 定义更新。"
    });
    return { approval, task };
  }
  try {
    if (mode !== "live") throw new RuntimeHttpError(409, "preview_self_definition_not_allowed");
    const operation = parseOperation(approval.operation);
    const task = await readTask(env.RUNTIME_DB, mateId, principal, mode, taskId);
    if (approval.releaseId !== definition.release.id || task.releaseId !== definition.release.id
      || approval.manifestSha256 !== definition.release.manifestSha256
      || approval.toolDefinitionVersion !== TOOL_VERSION
      || approval.actionDigest !== await digest(definition, operation)) {
      throw new RuntimeHttpError(409, "approval_release_or_action_changed");
    }
    const review = await reviewSelfDefinition(env, definition, principal);
    if (review.activeReleaseId !== operation.change.expectedReleaseId
      || review.draftRevision !== operation.change.expectedDraftRevision) {
      throw new RuntimeHttpError(409, "mate_definition_changed");
    }
    const consumed = await consumeApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId);
    await resumeTaskAfterApproval(env.RUNTIME_DB, mateId, principal, mode, taskId, approvalId);
    const result = await applySelfDefinition(env, definition, principal, operation.change);
    const completed = await concludeTask(env.RUNTIME_DB, mateId, principal.userId, mode, taskId, {
      actions: [{ actionDigest: approval.actionDigest, approvalId, type: "mate.definition.published" }],
      artifacts: [], failures: [], followUps: [], outcome: "completed", pendingApprovals: [],
      summary: `Mate 定义已发布为 Release ${record(result.release).id || "new"}。`
    });
    return { approval: consumed, result, task: completed };
  } catch (error) {
    try { await consumeApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId); }
    catch { /* Another request may have consumed this approval. */ }
    const result = await failed(env, definition, principal, mode, taskId, error, approvalId);
    return { ...result, approval: await readApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId) };
  }
}

function parseOperation(value: unknown): SelfDefinitionOperation {
  const operation = record(value);
  if (operation.type !== "mate_self_definition_update") {
    throw new RuntimeHttpError(400, "mate_definition_operation_invalid");
  }
  return { type: "mate_self_definition_update", change: parseChange(operation.change) };
}

function parseChange(value: unknown): OwnerMateDefinitionChange {
  const result = changeSchema.safeParse(value);
  if (!result.success || JSON.stringify(result.data).length > 400_000) {
    throw new RuntimeHttpError(400, "mate_definition_change_invalid");
  }
  return result.data as OwnerMateDefinitionChange;
}

async function digest(definition: RuntimeDefinition, operation: SelfDefinitionOperation) {
  const value = stableJson({ operation, releaseId: definition.release.id, manifestSha256: definition.release.manifestSha256, toolVersion: TOOL_VERSION });
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function failed(
  env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal,
  mode: RuntimeMode, taskId: string, error: unknown, approvalId?: string
) {
  const code = error instanceof RuntimeHttpError ? error.code : "mate_definition_update_failed";
  const current = await readTask(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId);
  if (["completed", "failed", "cancelled"].includes(String(current.status))) return { task: current };
  return { task: await concludeTask(env.RUNTIME_DB, definition.mate.id, principal.userId, mode, taskId, {
    actions: [], artifacts: [], errorCode: code, failures: [{ approvalId, code }],
    followUps: [], outcome: "failed", pendingApprovals: [], summary: `Mate 定义更新失败（${code}）。`
  }) };
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
