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
import { callRuntimeWorkspacePassTool } from "./workspacePassMcpClient.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimeMode, type RuntimePrincipal } from "./types.ts";

const FORUM_POST_TOOL_VERSION = "workspace.forum-post/v1";

type ForumPostOperation = {
  bodyMarkdown: string;
  categorySlug?: "ai-exploration" | "ai-investment" | "platform-help" | "off-topic";
  tags?: string[];
  title: string;
  topicType?: "help" | "question" | "idea" | "showcase" | "official" | "release";
  type: "workspace_forum_create_topic";
};

export function isForumPostOperation(value: unknown) {
  return record(value).type === "workspace_forum_create_topic";
}

export async function executeForumPostTask(
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
    assertForumPostBound(definition);
    if (mode === "preview") throw new RuntimeHttpError(409, "preview_forum_post_not_allowed");
    const operation = forumPostOperation(input.operation);
    const actionDigest = await forumPostActionDigest(definition, operation);
    const approval = await createApproval(env.RUNTIME_DB, mateId, principal, mode, taskId, {
      actionDigest,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      manifestSha256: definition.release.manifestSha256,
      operation,
      policyVersion: "current-user-single-use/v1",
      releaseId: definition.release.id,
      riskLevel: "medium",
      toolDefinitionVersion: FORUM_POST_TOOL_VERSION
    });
    return { approval, task: await readTask(env.RUNTIME_DB, mateId, principal, mode, taskId) };
  } catch (error) {
    return failedForumPost(env, definition, principal, mode, taskId, error);
  }
}

export async function decideAndExecuteForumPostApproval(
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
      actions: [], artifacts: [], failures: [{ approvalId, code: "forum_post_denied" }], followUps: [],
      outcome: "cancelled", pendingApprovals: [], summary: "Forum 发帖未获当前用户批准，任务已取消。"
    });
    return { approval, task };
  }

  try {
    assertForumPostBound(definition);
    const operation = forumPostOperation(approval.operation);
    const task = await readTask(env.RUNTIME_DB, mateId, principal, mode, taskId);
    const actionDigest = await forumPostActionDigest(definition, operation);
    if (
      approval.releaseId !== definition.release.id
      || task.releaseId !== definition.release.id
      || approval.manifestSha256 !== definition.release.manifestSha256
      || approval.toolDefinitionVersion !== FORUM_POST_TOOL_VERSION
    ) throw new RuntimeHttpError(409, "approval_release_changed");
    if (approval.actionDigest !== actionDigest) throw new RuntimeHttpError(409, "approval_action_changed");

    const consumed = await consumeApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId);
    await resumeTaskAfterApproval(env.RUNTIME_DB, mateId, principal, mode, taskId, approvalId);
    const { type: _operationType, ...forumInput } = operation;
    const published = await callRuntimeWorkspacePassTool(env, principal, "forum_write", {
      ...forumInput,
      action: "create_topic",
      idempotencyKey: `mate:${taskId}:${actionDigest.slice(-32)}`
    }, { approved: true, mateId: mateId });
    const topic = record(record(published).topic);
    const topicId = text(topic.id);
    const completed = await concludeTask(env.RUNTIME_DB, mateId, principal.userId, mode, taskId, {
      actions: [{ actionDigest, approvalId, topicId, type: "forum.topic.created" }],
      artifacts: [{ title: text(topic.title) || operation.title, topicId, type: "forum_topic" }],
      failures: [], followUps: [], outcome: "completed", pendingApprovals: [],
      summary: `已按当前用户身份发布 Workspace Forum 主题“${text(topic.title) || operation.title}”。`
    });
    return { approval: consumed, task: completed, topic };
  } catch (error) {
    try { await consumeApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId); }
    catch { /* Single-use Approval may already be consumed by a concurrent request. */ }
    const result = await failedForumPost(env, definition, principal, mode, taskId, error, approvalId);
    return { ...result, approval: await readApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId) };
  }
}

function forumPostOperation(value: unknown): ForumPostOperation {
  const operation = record(value);
  if (operation.type !== "workspace_forum_create_topic") throw new RuntimeHttpError(400, "forum_post_operation_invalid");
  const title = text(operation.title).trim().slice(0, 140);
  const bodyMarkdown = text(operation.bodyMarkdown).trim().slice(0, 8_000);
  if (!title || !bodyMarkdown) throw new RuntimeHttpError(400, "forum_post_operation_invalid");
  const categorySlug = optionalEnumValue(
    operation.categorySlug,
    ["ai-exploration", "ai-investment", "platform-help", "off-topic"] as const,
    "forum_post_category_invalid"
  );
  const topicType = optionalEnumValue(
    operation.topicType,
    ["help", "question", "idea", "showcase", "official", "release"] as const,
    "forum_post_topic_type_invalid"
  );
  const tags = Array.isArray(operation.tags)
    ? [...new Set(operation.tags.map(text).map((tag) => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, 8)
    : [];
  return {
    bodyMarkdown,
    ...(categorySlug ? { categorySlug } : {}),
    ...(tags.length ? { tags } : {}),
    title,
    ...(topicType ? { topicType } : {}),
    type: "workspace_forum_create_topic"
  };
}

async function forumPostActionDigest(definition: RuntimeDefinition, operation: ForumPostOperation) {
  const payload = stableJson({
    manifestSha256: definition.release.manifestSha256,
    operation,
    releaseId: definition.release.id,
    toolDefinitionVersion: FORUM_POST_TOOL_VERSION
  });
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)));
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function failedForumPost(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string,
  error: unknown,
  approvalId?: string
) {
  const code = error instanceof RuntimeHttpError ? error.code : "forum_post_failed";
  const current = await readTask(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId);
  if (["completed", "failed", "cancelled"].includes(String(current.status))) return { task: current };
  return {
    task: await concludeTask(env.RUNTIME_DB, definition.mate.id, principal.userId, mode, taskId, {
      actions: [], artifacts: [], errorCode: code, failures: [{ approvalId, code }],
      followUps: ["检查 Forum 权限、Release 绑定或审批状态后重试。"], outcome: "failed", pendingApprovals: [],
      summary: `Mate 未发布 Forum 主题（${code}）。`
    })
  };
}

function assertForumPostBound(definition: RuntimeDefinition) {
  if (!definition.release.manifest.resources.builtInToolBindings.some((binding) => binding.toolId === "workspace_forum_post")) {
    throw new RuntimeHttpError(403, "forum_post_not_bound_to_release");
  }
}

function optionalEnumValue<const T extends readonly string[]>(value: unknown, values: T, errorCode: string): T[number] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const candidate = text(value).trim();
  if (!values.includes(candidate)) throw new RuntimeHttpError(400, errorCode);
  return candidate as T[number];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
