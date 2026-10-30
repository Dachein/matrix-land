import type { Env, Principal, SupportedAgent } from "./types.ts";
import { schedulePortalLiveEvent } from "../../../src/shared/portalLivePublisher.ts";

const ACTIVITY_GROUP_WINDOW_MS = 15 * 60 * 1000;

export type AgentToolActivityStatus = "blocked" | "failed" | "succeeded";

type AgentToolActivityInput = {
  args: Record<string, unknown>;
  durationMs: number;
  error?: unknown;
  now?: Date;
  principal: Principal;
  requestId: string;
  result?: unknown;
  rpcId?: null | number | string;
  status: AgentToolActivityStatus;
  toolName: string;
};

type AgentActivityDescriptor = {
  actionType: `agent.${string}`;
  capability: "forum" | "hub" | "knowledge" | "apps" | "tool";
  family: string;
  href: string;
  targetType: string;
  verbEn: string;
  verbZh: string;
};

type AgentActivityTarget = {
  groupScopeId: string;
  id: string;
  title: string;
  type: string;
};

type McpForumCommunityActivityInput = {
  actionType: "forum.reply.created" | "forum.topic.created";
  actorName: string;
  actorTeam?: string;
  actorUserId: string;
  href: string;
  metadata: Record<string, unknown>;
  parentId?: string;
  parentTitle?: string;
  parentType?: "forum_topic";
  sourceEventId: string;
  summary: string;
  targetId: string;
  targetTitle: string;
  targetType: "forum_post" | "forum_topic";
  teamId?: string;
};

export async function emitMcpForumCommunityActivity(
  env: Env,
  input: McpForumCommunityActivityInput,
  executionContext?: Pick<ExecutionContext, "waitUntil">
) {
  const eventId = crypto.randomUUID();

  try {
    const result = await env.DB
      .prepare(
        `
        INSERT OR IGNORE INTO activity_events (
          id,
          scenario,
          action_type,
          actor_user_id,
          actor_name,
          actor_avatar_url,
          actor_team,
          target_type,
          target_id,
          target_title,
          parent_type,
          parent_id,
          parent_title,
          summary,
          href,
          visibility,
          team_id,
          metadata_json,
          source,
          source_event_id,
          created_at
        )
        VALUES (?, 'community', ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'org', ?, ?, 'mcp', ?, CURRENT_TIMESTAMP)
        `
      )
      .bind(
        eventId,
        input.actionType,
        input.actorUserId,
        input.actorName,
        readString(input.actorTeam),
        input.targetType,
        input.targetId,
        input.targetTitle,
        input.parentType ?? null,
        input.parentId ?? null,
        input.parentTitle ?? null,
        input.summary,
        input.href,
        input.teamId ?? null,
        JSON.stringify(input.metadata),
        input.sourceEventId
      )
      .run();
    const inserted = typeof result?.meta?.changes !== "number" || result.meta.changes > 0;
    if (!inserted) {
      return undefined;
    }
  } catch (error) {
    console.warn("forum_community_activity_write_failed", {
      actionType: input.actionType,
      errorName: error instanceof Error ? error.name : typeof error,
      sourceEventId: input.sourceEventId
    });
    return undefined;
  }

  scheduleMcpPortalLiveEvent(env, { activityEventId: eventId }, executionContext);
  return eventId;
}

export function scheduleMcpForumNotifications(
  env: Env,
  notificationIds: string[],
  executionContext?: Pick<ExecutionContext, "waitUntil">
) {
  notificationIds.forEach((notificationId) => {
    scheduleMcpPortalLiveEvent(env, { notificationId }, executionContext);
  });
}

function scheduleMcpPortalLiveEvent(
  env: Env,
  lookup: { activityEventId: string } | { notificationId: string },
  executionContext?: Pick<ExecutionContext, "waitUntil">
) {
  schedulePortalLiveEvent({
    env,
    waitUntil: executionContext
      ? (promise) => executionContext.waitUntil(promise)
      : undefined
  }, lookup);
}

export async function recordAgentToolActivity(
  env: Env,
  input: AgentToolActivityInput,
  executionContext?: Pick<ExecutionContext, "waitUntil">
) {
  if (!env.DB) {
    return undefined;
  }

  const descriptor = describeAgentTool(input.toolName);
  const target = activityTarget(descriptor, input.args, input.result);
  const occurredAt = input.now ?? new Date();
  const agentType = normalizeAgentType(input.principal.agentType);
  const agentName = agentDisplayName(agentType);
  const groupId = await agentActivityGroupId({
    actorUserId: input.principal.sub,
    capability: descriptor.capability,
    connectionId: input.principal.connectionId ?? agentType,
    family: descriptor.family,
    occurredAt,
    targetScopeId: target.groupScopeId
  });
  const summaries = activitySummaries({
    agentName,
    descriptor,
    status: input.status,
    targetTitle: target.title,
    version: activityVersion(input.result)
  });
  const errorCode = activityErrorCode(input.error);
  const eventId = crypto.randomUUID();
  const sourceEventId = `agent-tool:${input.requestId}:${input.status}`;
  const metadata = compactRecord({
    activitySummaryEn: summaries.en,
    activitySummaryZh: summaries.zh,
    agentId: input.principal.connectionId ?? `${agentType}:${input.principal.sub}`,
    agentName,
    agentType,
    capability: descriptor.capability,
    connectionId: input.principal.connectionId,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    errorCode,
    groupId,
    operationId: input.requestId,
    rpcId: input.rpcId === null || input.rpcId === undefined ? undefined : String(input.rpcId),
    status: input.status,
    targetTitle: target.title,
    toolName: input.toolName,
    versionId: activityVersionId(input.result),
    versionNumber: activityVersion(input.result)
  });

  try {
    const result = await env.DB
      .prepare(
        `
        INSERT OR IGNORE INTO activity_events (
          id,
          scenario,
          action_type,
          actor_user_id,
          actor_name,
          actor_avatar_url,
          actor_team,
          target_type,
          target_id,
          target_title,
          parent_type,
          parent_id,
          parent_title,
          summary,
          href,
          visibility,
          team_id,
          metadata_json,
          source,
          source_event_id,
          created_at
        )
        VALUES (?, 'agent', ?, ?, ?, '', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 'private', ?, ?, 'workspace-mcp-worker', ?, ?)
        `
      )
      .bind(
        eventId,
        input.status === "succeeded" ? descriptor.actionType : input.status === "blocked" ? "agent.tool.blocked" : "agent.tool.failed",
        input.principal.sub,
        readString(input.principal.name) || readString(input.principal.email) || "Workspace user",
        readString(input.principal.team),
        target.type,
        target.id,
        target.title,
        summaries.zh,
        descriptor.href,
        input.principal.teamId ?? null,
        JSON.stringify(metadata),
        sourceEventId,
        occurredAt.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")
      )
      .run();
    const inserted = typeof result?.meta?.changes !== "number" || result.meta.changes > 0;
    if (inserted) {
      schedulePortalLiveEvent({
        env,
        waitUntil: executionContext
          ? (promise) => executionContext.waitUntil(promise)
          : undefined
      }, { activityEventId: eventId });
    }
  } catch (error) {
    console.warn("agent_activity_write_failed", {
      errorName: error instanceof Error ? error.name : typeof error,
      requestId: input.requestId,
      toolName: input.toolName
    });
    return undefined;
  }

  return {
    actionType: input.status === "succeeded" ? descriptor.actionType : input.status === "blocked" ? "agent.tool.blocked" : "agent.tool.failed",
    eventId,
    groupId,
    metadata,
    sourceEventId,
    summary: summaries.zh,
    target,
    visibility: "private" as const
  };
}

export async function agentActivityGroupId(input: {
  actorUserId: string;
  capability: string;
  connectionId: string;
  family: string;
  occurredAt: Date;
  targetScopeId: string;
}) {
  const bucket = Math.floor(input.occurredAt.getTime() / ACTIVITY_GROUP_WINDOW_MS);
  const value = [
    "agent-activity-v1",
    input.actorUserId,
    input.connectionId,
    input.capability,
    input.family,
    input.targetScopeId,
    String(bucket)
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `ag_${Array.from(new Uint8Array(digest)).slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function describeAgentTool(toolName: string): AgentActivityDescriptor {
  const name = canonicalActivityToolName(toolName);

  if (name.startsWith("knowledge_")) {
    if (name === "knowledge_edit_file_upload") {
      return descriptor("agent.knowledge.file.created", "knowledge", "knowledge.write", "knowledge_file", "上传了", "uploaded", "#/knowledge");
    }
    if (
      name === "knowledge_edit_file_update"
      || name === "knowledge_edit_file_edit"
      || name === "knowledge_edit_batch"
    ) {
      return descriptor("agent.knowledge.file.updated", "knowledge", "knowledge.write", "knowledge_file", "更新了", "updated", "#/knowledge");
    }
    if (name === "knowledge_edit_service_update") {
      return descriptor("agent.knowledge.service.updated", "knowledge", "knowledge.write", "knowledge_service", "更新了知识库信息", "updated service info for", "#/knowledge");
    }
    if (name === "knowledge_edit_folder_create") {
      return descriptor("agent.knowledge.folder.created", "knowledge", "knowledge.write", "knowledge_folder", "创建了文件夹", "created folder", "#/knowledge");
    }
    if (name === "knowledge_edit_object_rename") {
      return descriptor("agent.knowledge.object.renamed", "knowledge", "knowledge.write", "knowledge_object", "重命名了", "renamed", "#/knowledge");
    }
    if (name === "knowledge_edit_object_delete") {
      return descriptor("agent.knowledge.object.deleted", "knowledge", "knowledge.delete", "knowledge_object", "删除了", "deleted", "#/knowledge");
    }
    if (name === "knowledge_file_public_share_create") {
      return descriptor("agent.knowledge.share.created", "knowledge", "knowledge.share", "knowledge_file", "创建了公开链接", "created a public link for", "#/knowledge");
    }
    if (name === "knowledge_file_public_share_revoke") {
      return descriptor("agent.knowledge.share.revoked", "knowledge", "knowledge.share", "knowledge_file", "撤销了公开链接", "revoked the public link for", "#/knowledge");
    }
    if (name === "knowledge_file_public_share_get") {
      return descriptor("agent.knowledge.share.checked", "knowledge", "knowledge.read", "knowledge_file", "检查了分享状态", "checked sharing for", "#/knowledge");
    }
    if (name.startsWith("knowledge_service_")) {
      return descriptor("agent.knowledge.consulted", "knowledge", "knowledge.read", "knowledge_service", "查阅了", "consulted", "#/knowledge");
    }
    if (name.startsWith("knowledge_audit_")) {
      return descriptor("agent.knowledge.audit.read", "knowledge", "knowledge.read", "knowledge_change", "查阅了变更记录", "reviewed change history for", "#/knowledge");
    }
    if (name.startsWith("knowledge_feedback_")) {
      return name === "knowledge_feedback_submit"
        ? descriptor("agent.knowledge.feedback.submitted", "knowledge", "knowledge.feedback", "knowledge_feedback", "提交了知识反馈", "submitted knowledge feedback for", "#/knowledge")
        : descriptor("agent.knowledge.feedback.read", "knowledge", "knowledge.feedback", "knowledge_feedback", "查阅了知识反馈", "reviewed knowledge feedback for", "#/knowledge");
    }
    return descriptor("agent.knowledge.source.read", "knowledge", "knowledge.read", "knowledge_object", "浏览了", "browsed", "#/knowledge");
  }

  if (name.startsWith("forum_")) {
    if (name === "forum_create_topic") {
      return descriptor("agent.forum.topic.created", "forum", "forum.write", "forum_topic", "发布了帖子", "published topic", "#/discussions");
    }
    if (name === "forum_update_topic") {
      return descriptor("agent.forum.topic.updated", "forum", "forum.write", "forum_topic", "更新了帖子", "updated topic", "#/discussions");
    }
    if (name === "forum_upload_media" || name === "upload_begin" || name === "upload_finalize") {
      return descriptor("agent.forum.media.uploaded", "forum", "forum.write", "forum_media", "上传了帖子图片", "uploaded forum image", "#/discussions");
    }
    if (name === "forum_create_reply") {
      return descriptor("agent.forum.reply.created", "forum", "forum.write", "forum_topic", "回复了帖子", "replied to topic", "#/discussions");
    }
    return descriptor("agent.forum.consulted", "forum", "forum.read", "community", "查阅了社区", "consulted the community", "#/discussions");
  }

  if (name.startsWith("upload_")) {
    return descriptor("agent.forum.media.uploaded", "forum", "forum.write", "forum_media", "上传了帖子图片", "uploaded forum image", "#/discussions");
  }

  if (name.startsWith("hub_")) {
    if (name === "hub_submit_listing") {
      return descriptor("agent.hub.listing.submitted", "hub", "hub.write", "publication_listing", "提交了上架审核", "submitted listing", "#/skills-apps");
    }
    return descriptor("agent.hub.consulted", "hub", "hub.read", "community", "浏览了 Skill Hub", "browsed Skill Hub", "#/skills-apps");
  }

  if (name.startsWith("apps_")) {
    if (name === "apps_pages_deploy" || name === "apps_worker_deploy") {
      return descriptor("agent.apps.deployment.prepared", "apps", "apps.deploy", "apps_deployment", "准备了部署", "prepared deployment", "#/apps");
    }
    if (name === "apps_deployments_publish") {
      return descriptor("agent.apps.deployment.published", "apps", "apps.publish", "apps_deployment", "发布了部署", "published deployment", "#/apps");
    }
    if (name === "apps_deployments_rollback") {
      return descriptor("agent.apps.deployment.rolled_back", "apps", "apps.publish", "apps_deployment", "回滚了部署", "rolled back deployment", "#/apps");
    }
    if (name === "apps_skill_submit") {
      return descriptor("agent.apps.skill.submitted", "apps", "apps.skill.write", "apps_skill", "发布了 Skill", "published Skill", "#/apps");
    }
    if (name === "apps_skill_update") {
      return descriptor("agent.apps.skill.updated", "apps", "apps.skill.write", "apps_skill", "更新了 Skill", "updated Skill", "#/apps");
    }
    if (isAppsMutation(name)) {
      return descriptor("agent.apps.resource.changed", "apps", "apps.write", "apps_app", "更新了 APPS 资源", "updated APPS resource", "#/apps");
    }
    return descriptor("agent.apps.consulted", "apps", "apps.read", "apps_app", "查阅了 APPS", "consulted APPS", "#/apps");
  }

  return descriptor("agent.tool.completed", "tool", "tool.call", "mcp_tool", "调用了能力", "called capability", "#/home");
}

function descriptor(
  actionType: `agent.${string}`,
  capability: AgentActivityDescriptor["capability"],
  family: string,
  targetType: string,
  verbZh: string,
  verbEn: string,
  href: string
): AgentActivityDescriptor {
  return { actionType, capability, family, href, targetType, verbEn, verbZh };
}

function activityTarget(
  descriptor: AgentActivityDescriptor,
  args: Record<string, unknown>,
  result: unknown
): AgentActivityTarget {
  const resultRecord = readRecord(result);
  const item = readRecord(resultRecord.item);
  const topic = readRecord(resultRecord.topic);
  const listing = readRecord(resultRecord.listing);
  const namespace = readRecord(resultRecord.namespace);
  const candidate = Object.keys(item).length > 0 ? item : Object.keys(topic).length > 0 ? topic : listing;
  const serviceId = firstString(item.knowledgeServiceId, resultRecord.serviceId, args.serviceId);
  const objectId = firstString(candidate.id, resultRecord.objectId, args.objectId, args.fileId, args.folderObjectId);
  const appId = firstString(resultRecord.appId, args.appId);
  const skillId = firstString(resultRecord.skillId, args.skillId);
  const topicId = firstString(topic.id, resultRecord.topicId, args.topicId);
  const listingId = firstString(listing.id, resultRecord.listingId, args.listingId);
  const id = firstString(
    objectId,
    serviceId,
    topicId,
    listingId,
    skillId,
    appId,
    args.deploymentId,
    args.parentObjectId,
    descriptor.capability
  ) || descriptor.capability;
  const title = firstString(
    candidate.name,
    candidate.title,
    candidate.path,
    resultRecord.name,
    resultRecord.title,
    args.fileName,
    args.name,
    args.title,
    defaultTargetTitle(descriptor)
  ) || defaultTargetTitle(descriptor);
  const groupScopeId = firstString(
    serviceId,
    namespace.id,
    args.parentObjectId,
    objectId,
    topicId,
    listingId,
    skillId,
    appId,
    descriptor.capability
  ) || descriptor.capability;

  return { groupScopeId, id, title: title.slice(0, 240), type: descriptor.targetType };
}

function activitySummaries(input: {
  agentName: string;
  descriptor: AgentActivityDescriptor;
  status: AgentToolActivityStatus;
  targetTitle: string;
  version?: string;
}) {
  const targetZh = input.targetTitle ? `「${input.targetTitle}」` : "";
  const targetEn = input.targetTitle ? ` “${input.targetTitle}”` : "";
  const versionZh = input.version ? `至 v${input.version}` : "";
  const versionEn = input.version ? ` to v${input.version}` : "";

  if (input.status === "blocked") {
    return {
      en: `${input.agentName} is waiting for confirmation to ${input.descriptor.verbEn}${targetEn}`,
      zh: `${input.agentName} 等待确认：${input.descriptor.verbZh}${targetZh}`
    };
  }
  if (input.status === "failed") {
    return {
      en: `${input.agentName} could not ${input.descriptor.verbEn}${targetEn}`,
      zh: `${input.agentName} 未能${input.descriptor.verbZh}${targetZh}`
    };
  }
  return {
    en: `${input.agentName} ${input.descriptor.verbEn}${targetEn}${versionEn}`,
    zh: `${input.agentName} ${input.descriptor.verbZh}${targetZh}${versionZh}`
  };
}

function canonicalActivityToolName(toolName: string) {
  if (toolName === "knowledge_tree") return "knowledge_edit_list";
  if (toolName === "knowledge_file_get") return "knowledge_edit_file_read";
  if (toolName === "knowledge_folder_create") return "knowledge_edit_folder_create";
  if (toolName === "knowledge_file_update") return "knowledge_edit_file_update";
  if (toolName === "knowledge_public_share_create") return "knowledge_file_public_share_create";
  if (toolName === "knowledge_services_list") return "knowledge_service_list";
  if (toolName === "knowledge_file_upload") return "knowledge_edit_file_upload";
  return toolName;
}

function isAppsMutation(name: string) {
  return name.includes("_set")
    || name.includes("_put")
    || name.includes("_delete")
    || name.includes("_apply")
    || name.includes("_declare")
    || name.includes("_update")
    || name.includes("_submit");
}

function defaultTargetTitle(descriptor: AgentActivityDescriptor) {
  if (descriptor.targetType === "knowledge_file") return "知识文件";
  if (descriptor.targetType === "knowledge_folder") return "知识文件夹";
  if (descriptor.targetType === "knowledge_service") return "Agent 知识库";
  if (descriptor.capability === "forum") return "Workspace 社区";
  if (descriptor.capability === "hub") return "Skill Hub";
  if (descriptor.capability === "apps") return "APPS";
  return "Workspace MCP";
}

function activityVersion(result: unknown) {
  const version = readRecord(readRecord(result).version);
  const value = firstString(version.version, readRecord(result).versionNumber);
  return value || undefined;
}

function activityVersionId(result: unknown) {
  const version = readRecord(readRecord(result).version);
  return firstString(version.id, readRecord(result).versionId) || undefined;
}

function activityErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  return firstString(record.code, error instanceof Error ? error.name : undefined) || undefined;
}

function normalizeAgentType(value: SupportedAgent | undefined): SupportedAgent {
  return value === "claude-code" || value === "workbuddy" || value === "cursor" ? value : "codex";
}

function agentDisplayName(agentType: SupportedAgent) {
  if (agentType === "claude-code") return "Claude Code";
  if (agentType === "workbuddy") return "WorkBuddy";
  if (agentType === "cursor") return "Cursor";
  return "Codex";
}

function compactRecord(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const text = readString(value).trim();
    if (text) return text;
  }
  return "";
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}
