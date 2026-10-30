import type { PortalCatalog } from "../../../../src/shared/types";
import {
  normalizePortalLiveHref,
  type PortalLiveAgent,
  type PortalLiveActivity,
  type PortalLivePerson
} from "../../../../src/shared/portalLive";
import type { ActivityEvent } from "../../../../src/shared/types";

export type LiveConnectionState = "connected" | "connecting" | "offline" | "reconnecting";

export type LivePerson = PortalLivePerson;

export type LiveActivityItem = PortalLiveActivity;

export type LiveSnapshot = {
  activities: LiveActivityItem[];
  connectionState: LiveConnectionState;
  cursor?: string;
  error?: string;
  onlinePeople: LivePerson[];
};

export interface LiveDataSource {
  getSnapshot(): LiveSnapshot;
  start?(): void;
  stop?(): void;
  subscribe?(listener: (snapshot: LiveSnapshot) => void): () => void;
}

export function createCatalogLiveDataSource(
  catalog: PortalCatalog,
  connectionState: LiveConnectionState
): LiveDataSource {
  const onlinePeople: LivePerson[] = [{
    avatarUrl: catalog.currentUser.avatarUrl,
    detail: "",
    id: catalog.currentUser.id,
    name: catalog.currentUser.name
  }];
  const catalogActivities = catalog.activityEvents
    .slice(0, 30)
    .map((event) => activityFromCatalogEvent(event, catalog.currentUser.id));
  const discussionActivities = catalog.discussions.slice(0, 20).map((discussion) => ({
      actorAvatarUrl: discussion.authorAvatarUrl,
      actorName: discussion.author,
      actorUserId: discussion.authorId,
      createdAt: discussion.lastActive,
      href: `#/posts/${encodeURIComponent(discussion.id)}`,
      id: `discussion-activity-${discussion.id}`,
      priority: false,
      summary: discussion.title
    }));
  const activities = [...catalogActivities, ...discussionActivities];

  const snapshot: LiveSnapshot = {
    activities,
    connectionState,
    onlinePeople
  };

  return {
    getSnapshot: () => snapshot
  };
}

export function activityFromCatalogEvent(event: ActivityEvent, currentUserId: string): PortalLiveActivity {
  const targetsCurrentUser = activityTargetsUser(event.metadata, currentUserId);
  const agent = agentFromMetadata(event.metadata, event);

  return {
    actorAvatarUrl: event.actorAvatarUrl,
    actorName: event.actorName,
    actorUserId: event.actorUserId,
    agent,
    channel: liveChannelFromEvent(event, targetsCurrentUser, agent),
    createdAt: event.createdAt,
    entityId: event.targetId,
    entityType: event.targetType,
    eventType: event.actionType,
    href: normalizePortalLiveHref(event.href),
    id: event.id,
    metadata: event.metadata,
    priority: event.visibility === "private" || targetsCurrentUser,
    summary: event.summary
  };
}

export function activityTargetsUser(metadata: Record<string, unknown> | undefined, userId: string) {
  if (!metadata || !userId) {
    return false;
  }

  if (metadata.recipientUserId === userId) {
    return true;
  }

  return Array.isArray(metadata.recipientUserIds)
    && metadata.recipientUserIds.some((recipientUserId) => recipientUserId === userId);
}

function liveChannelFromEvent(event: ActivityEvent, targetsCurrentUser: boolean, agent: PortalLiveAgent | undefined) {
  if (event.actionType.startsWith("agent.") || event.targetType === "agent" || agent) {
    return "agent" as const;
  }

  return targetsCurrentUser || event.visibility === "private" ? "direct" as const : "community" as const;
}

function agentFromMetadata(metadata: Record<string, unknown> | undefined, event: ActivityEvent): PortalLiveAgent | undefined {
  const agentId = readOptionalString(metadata?.agentId) ?? (event.targetType === "agent" ? event.targetId : undefined);
  const name = readOptionalString(metadata?.agentName);
  const type = normalizeAgentType(metadata?.agentType ?? name ?? agentId);

  if (!agentId && !name && !event.actionType.startsWith("agent.")) {
    return undefined;
  }

  return {
    id: agentId,
    name,
    type
  };
}

function normalizeAgentType(value: unknown): PortalLiveAgent["type"] {
  const text = String(value ?? "").trim().toLowerCase();
  if (text.includes("workbuddy") || text.includes("work buddy")) return "workbuddy";
  if (text.includes("chatgpt") || text.includes("openai")) return "chatgpt";
  if (text.includes("cursor")) return "cursor";
  if (text.includes("codex")) return "codex";
  if (text.includes("claude") || text.includes("anthropic")) return "claude";
  return "generic";
}

function readOptionalString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}
