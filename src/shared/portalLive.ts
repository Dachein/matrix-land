export const PORTAL_LIVE_PROTOCOL_VERSION = 1 as const;
export const PORTAL_LIVE_CURSOR_STORAGE_KEY = "workspace.portalLive.cursor.v1";

export type PortalLiveActivityChannel = "agent" | "community" | "direct";

export type PortalLiveAgent = {
  id?: string;
  name?: string;
  type?: "chatgpt" | "claude" | "codex" | "cursor" | "generic" | "workbuddy";
};

export type PortalLiveActivity = {
  actorAvatarUrl?: string;
  actorUserId?: string;
  actorName: string;
  agent?: PortalLiveAgent;
  channel?: PortalLiveActivityChannel;
  createdAt: string;
  entityId?: string;
  entityType?: string;
  eventType?: string;
  href?: string;
  id: string;
  metadata?: Record<string, unknown>;
  notificationId?: string;
  priority: boolean;
  summary: string;
  unread?: boolean;
};

export type PortalLivePerson = {
  avatarUrl?: string;
  detail: string;
  id: string;
  name: string;
};

type MessageEnvelope = {
  cursor?: string;
  sentAt: string;
  version: typeof PORTAL_LIVE_PROTOCOL_VERSION;
};

export type PortalLiveClientMessage = MessageEnvelope & {
  type: "subscribe";
  workspaceId: string;
};

export type PortalLiveServerMessage = MessageEnvelope & (
  | { type: "snapshot"; activities: PortalLiveActivity[]; onlinePeople: PortalLivePerson[] }
  | { type: "activity.upsert"; activity: PortalLiveActivity }
  | { type: "presence.sync"; onlinePeople: PortalLivePerson[] }
  | { type: "heartbeat" }
  | { type: "error"; code: string; message: string }
);

export function parsePortalLiveClientMessage(raw: string): PortalLiveClientMessage | undefined {
  const value = parseRecord(raw);
  if (!hasEnvelope(value) || value.type !== "subscribe" || typeof value.workspaceId !== "string") {
    return undefined;
  }

  const workspaceId = value.workspaceId.trim();
  if (!workspaceId) {
    return undefined;
  }

  return {
    cursor: optionalString(value.cursor),
    sentAt: value.sentAt,
    type: "subscribe",
    version: PORTAL_LIVE_PROTOCOL_VERSION,
    workspaceId
  };
}

export function parsePortalLiveServerMessage(raw: string): PortalLiveServerMessage | undefined {
  const value = parseRecord(raw);
  if (!hasEnvelope(value)) {
    return undefined;
  }

  const envelope = {
    cursor: optionalString(value.cursor),
    sentAt: value.sentAt,
    version: PORTAL_LIVE_PROTOCOL_VERSION
  };

  if (value.type === "snapshot" && Array.isArray(value.activities) && Array.isArray(value.onlinePeople)) {
    const activities = value.activities.filter(isPortalLiveActivity);
    const onlinePeople = value.onlinePeople.filter(isPortalLivePerson);
    return activities.length === value.activities.length && onlinePeople.length === value.onlinePeople.length
      ? { ...envelope, type: "snapshot", activities, onlinePeople }
      : undefined;
  }

  if (value.type === "activity.upsert" && isPortalLiveActivity(value.activity)) {
    return { ...envelope, type: "activity.upsert", activity: value.activity };
  }

  if (value.type === "presence.sync" && Array.isArray(value.onlinePeople)) {
    const onlinePeople = value.onlinePeople.filter(isPortalLivePerson);
    return onlinePeople.length === value.onlinePeople.length
      ? { ...envelope, type: "presence.sync", onlinePeople }
      : undefined;
  }

  if (value.type === "heartbeat") {
    return { ...envelope, type: "heartbeat" };
  }

  if (value.type === "error" && typeof value.code === "string" && typeof value.message === "string") {
    return { ...envelope, type: "error", code: value.code, message: value.message };
  }

  return undefined;
}

export function isPortalLiveActivity(value: unknown): value is PortalLiveActivity {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.actorName === "string"
    && typeof value.createdAt === "string"
    && typeof value.priority === "boolean"
    && typeof value.summary === "string"
    && optionalFieldsAreStrings(value, [
      "actorAvatarUrl",
      "actorUserId",
      "entityId",
      "entityType",
      "eventType",
      "href",
      "notificationId"
    ])
    && optionalActivityChannelIsValid(value.channel)
    && (value.agent === undefined || isPortalLiveAgent(value.agent))
    && (value.metadata === undefined || isRecord(value.metadata))
    && (value.unread === undefined || typeof value.unread === "boolean");
}

export function isPortalLivePerson(value: unknown): value is PortalLivePerson {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.detail === "string"
    && typeof value.name === "string"
    && optionalFieldsAreStrings(value, ["avatarUrl"]);
}

export function normalizePortalLiveHref(href?: string) {
  if (!href) {
    return undefined;
  }

  const legacyDiscussion = href.match(/^#discussion-(.+)$/);
  if (legacyDiscussion?.[1]) {
    return `#/posts/${encodeURIComponent(legacyDiscussion[1])}`;
  }

  const legacyCommunityTopic = href.match(/^#\/community\/([^/?]+)$/);
  if (legacyCommunityTopic?.[1]) {
    return `#/posts/${legacyCommunityTopic[1]}`;
  }

  return href;
}

export function portalLiveActivityChannel(activity: PortalLiveActivity): PortalLiveActivityChannel {
  if (activity.channel) {
    return activity.channel;
  }

  if (isPortalLiveAgentActivity(activity)) {
    return "agent";
  }

  return activity.notificationId || activity.unread ? "direct" : "community";
}

export function isPortalLiveAgentActivity(activity: PortalLiveActivity) {
  return activity.eventType?.startsWith("agent.") === true
    || activity.entityType === "agent"
    || Boolean(activity.agent?.id || activity.agent?.name);
}

function hasEnvelope(value: Record<string, unknown> | undefined): value is Record<string, unknown> & {
  sentAt: string;
  type: string;
  version: typeof PORTAL_LIVE_PROTOCOL_VERSION;
} {
  return Boolean(value)
    && value?.version === PORTAL_LIVE_PROTOCOL_VERSION
    && typeof value.type === "string"
    && typeof value.sentAt === "string";
}

function parseRecord(raw: string) {
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function optionalFieldsAreStrings(value: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => value[key] === undefined || typeof value[key] === "string");
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function optionalActivityChannelIsValid(value: unknown) {
  return value === undefined || value === "agent" || value === "community" || value === "direct";
}

function isPortalLiveAgent(value: unknown): value is PortalLiveAgent {
  return isRecord(value)
    && optionalFieldsAreStrings(value, ["id", "name"])
    && (
      value.type === undefined
      || value.type === "chatgpt"
      || value.type === "claude"
      || value.type === "codex"
      || value.type === "cursor"
      || value.type === "generic"
      || value.type === "workbuddy"
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
