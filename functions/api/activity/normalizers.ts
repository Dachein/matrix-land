import type { ActivityEvent, ActivityScenario } from "../../../src/shared/types";

type AgentActivityActionType = Extract<ActivityEvent["actionType"], `agent.${string}`>;

export const DEFAULT_ACTIVITY_EVENT_LIMIT = 5;
export const MAX_ACTIVITY_EVENT_LIMIT = 30;

export function normalizeActivityScenario(value: unknown): ActivityScenario | undefined {
  const scenario = readString(value);
  return scenario === "agent" || scenario === "community" || scenario === "apps" ? scenario : undefined;
}

export function normalizeActivityActionType(value: unknown): ActivityEvent["actionType"] {
  const actionType = readString(value);
  if (
    isAgentActivityActionType(actionType)
    || actionType === "community.member.joined"
    || actionType === "journey.badge.awarded"
    || actionType === "journey.level.upgraded"
    || actionType === "forum.topic.created"
    || actionType === "forum.reply.created"
    || actionType === "forum.reaction.created"
    || actionType === "forum.contribution.awarded"
    || actionType === "apps.app.published"
  ) {
    return actionType;
  }

  return "forum.topic.created";
}

export function isAgentActivityActionType(value: string): value is AgentActivityActionType {
  return value.startsWith("agent.") && value.length > "agent.".length;
}

export function normalizeActivityTargetType(value: unknown): ActivityEvent["targetType"] {
  const targetType = readString(value);
  if (
    targetType === "agent"
    || targetType === "community"
    || targetType === "knowledge_file"
    || targetType === "knowledge_folder"
    || targetType === "knowledge_object"
    || targetType === "knowledge_service"
    || targetType === "journey_badge"
    || targetType === "journey_level"
    || targetType === "forum_topic"
    || targetType === "forum_post"
    || targetType === "apps_app"
    || targetType === "apps_deployment"
    || targetType === "apps_skill"
    || targetType === "publication_listing"
    || targetType === "mcp_tool"
  ) {
    return targetType;
  }

  return "community";
}

export function normalizeActivityVisibility(value: unknown): ActivityEvent["visibility"] {
  const visibility = readString(value);
  if (visibility === "team" || visibility === "private") {
    return visibility;
  }

  return "org";
}

export function normalizeActivityLimit(value: unknown) {
  const limit = typeof value === "number" ? value : Number.parseInt(readString(value), 10);
  return Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), MAX_ACTIVITY_EVENT_LIMIT)
    : DEFAULT_ACTIVITY_EVENT_LIMIT;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}
