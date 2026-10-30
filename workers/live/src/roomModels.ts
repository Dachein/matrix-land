import {
  isPortalLiveActivity,
  type PortalLiveActivity,
  type PortalLivePerson
} from "../../../src/shared/portalLive";

export type LivePrincipal = {
  avatarUrl?: string;
  department?: string;
  id: string;
  name: string;
  team?: string;
  teamId?: string;
};

export type LiveAudience = {
  actorUserId?: string;
  recipientUserIds: string[];
  teamId?: string;
  visibility: "org" | "private" | "public" | "team";
};

export type StoredLiveActivity = {
  activity: PortalLiveActivity;
  audience: LiveAudience;
  cursor: string;
};

export type PublishedLiveEvent = {
  activity: PortalLiveActivity;
  audience: LiveAudience;
};

export type SocketAttachment = {
  connectionId: string;
  principal: LivePrincipal;
  subscribed: boolean;
  workspaceId: string;
};

const STORED_ACTIVITY_LIMIT = 120;
const STORED_CHANNEL_ACTIVITY_RESERVE = 60;
const ACTIVITY_SUMMARY_LIMIT = 600;
const ACTIVITY_TEXT_LIMIT = 256;
const ACTIVITY_URL_LIMIT = 2_048;
const METADATA_TEXT_LIMIT = 700;
const STORED_METADATA_KEYS = new Set([
  "activitySummaryEn",
  "activitySummaryZh",
  "agentId",
  "agentName",
  "agentType",
  "badgeTitle",
  "capability",
  "categoryId",
  "connectionId",
  "durationMs",
  "entityId",
  "entityType",
  "errorCode",
  "groupId",
  "listingName",
  "notificationType",
  "operationId",
  "parentId",
  "parentTitle",
  "parentType",
  "postId",
  "readAt",
  "recipientUserId",
  "recipientUserIds",
  "rpcId",
  "scenario",
  "source",
  "sourceEventId",
  "status",
  "targetTitle",
  "targetUserId",
  "title",
  "toolName",
  "topicId",
  "topicTitle",
  "versionId",
  "versionNumber"
]);

export function normalizeWorkspaceId(value: unknown) {
  const workspaceId = readString(value).trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,79}$/.test(workspaceId) ? workspaceId : "";
}

export function normalizePublishedLiveEvent(value: unknown): PublishedLiveEvent | undefined {
  if (!isRecord(value) || !isPortalLiveActivity(value.activity)) {
    return undefined;
  }

  const audienceValue = isRecord(value.audience) ? value.audience : {};
  return compactPublishedLiveEvent({
    activity: { ...value.activity, priority: false },
    audience: {
      actorUserId: readOptionalString(audienceValue.actorUserId),
      recipientUserIds: readStringList(audienceValue.recipientUserIds),
      teamId: readOptionalString(audienceValue.teamId),
      visibility: normalizeVisibility(audienceValue.visibility)
    }
  });
}

export function appendStoredActivity(
  log: StoredLiveActivity[],
  event: PublishedLiveEvent,
  cursor: string,
  limit = STORED_ACTIVITY_LIMIT
) {
  const compactEvent = compactPublishedLiveEvent(event);
  const existing = log.find((entry) => entry.activity.id === compactEvent.activity.id);
  if (existing && storedActivityEquals(existing, compactEvent)) {
    return log;
  }

  return retainStoredActivities([
    { ...compactEvent, cursor: truncateText(cursor, ACTIVITY_TEXT_LIMIT) },
    ...log.filter((entry) => entry.activity.id !== compactEvent.activity.id)
  ], limit);
}

export function compactStoredActivityLog(log: StoredLiveActivity[], limit = STORED_ACTIVITY_LIMIT) {
  return retainStoredActivities(log, limit).map((entry) => ({
    ...compactPublishedLiveEvent(entry),
    cursor: truncateText(entry.cursor, ACTIVITY_TEXT_LIMIT)
  }));
}

function retainStoredActivities(log: StoredLiveActivity[], limit: number) {
  if (log.length <= limit) {
    return log;
  }

  const communityIds = log
    .filter(isSharedCommunityActivity)
    .slice(0, Math.min(limit, STORED_CHANNEL_ACTIVITY_RESERVE))
    .map((entry) => entry.activity.id);
  const agentIds = log
    .filter((entry) => entry.activity.channel === "agent")
    .slice(0, Math.min(
      Math.max(0, limit - communityIds.length),
      STORED_CHANNEL_ACTIVITY_RESERVE
    ))
    .map((entry) => entry.activity.id);
  const selectedIds = new Set([...communityIds, ...agentIds]);

  for (const entry of log) {
    if (selectedIds.size >= limit) {
      break;
    }
    selectedIds.add(entry.activity.id);
  }

  return log.filter((entry) => selectedIds.has(entry.activity.id));
}

function isSharedCommunityActivity(entry: StoredLiveActivity) {
  return (entry.audience.visibility === "org" || entry.audience.visibility === "public")
    && entry.activity.channel !== "agent"
    && !entry.activity.notificationId;
}

export function compactPublishedLiveEvent(event: PublishedLiveEvent): PublishedLiveEvent {
  const activity = event.activity;
  const compactActivity: PortalLiveActivity = {
    actorName: truncateText(activity.actorName, ACTIVITY_TEXT_LIMIT),
    createdAt: truncateText(activity.createdAt, 64),
    id: truncateText(activity.id, ACTIVITY_TEXT_LIMIT),
    priority: false,
    summary: truncateText(activity.summary, ACTIVITY_SUMMARY_LIMIT)
  };

  assignOptionalUrl(compactActivity, "actorAvatarUrl", activity.actorAvatarUrl, ACTIVITY_URL_LIMIT);
  assignOptionalText(compactActivity, "actorUserId", activity.actorUserId, ACTIVITY_TEXT_LIMIT);
  assignOptionalText(compactActivity, "channel", activity.channel, 32);
  assignOptionalText(compactActivity, "entityId", activity.entityId, ACTIVITY_TEXT_LIMIT);
  assignOptionalText(compactActivity, "entityType", activity.entityType, 96);
  assignOptionalText(compactActivity, "eventType", activity.eventType, 128);
  assignOptionalText(compactActivity, "href", activity.href, ACTIVITY_URL_LIMIT);
  assignOptionalText(compactActivity, "notificationId", activity.notificationId, ACTIVITY_TEXT_LIMIT);

  if (activity.agent) {
    compactActivity.agent = {
      id: optionalTruncatedText(activity.agent.id, ACTIVITY_TEXT_LIMIT),
      name: optionalTruncatedText(activity.agent.name, ACTIVITY_TEXT_LIMIT),
      type: activity.agent.type
    };
  }
  if (activity.metadata) {
    compactActivity.metadata = compactMetadata(activity.metadata);
  }
  if (activity.unread !== undefined) {
    compactActivity.unread = activity.unread;
  }

  return {
    activity: compactActivity,
    audience: {
      actorUserId: optionalTruncatedText(event.audience.actorUserId, ACTIVITY_TEXT_LIMIT),
      recipientUserIds: event.audience.recipientUserIds
        .map((value) => truncateText(value, ACTIVITY_TEXT_LIMIT))
        .filter(Boolean)
        .slice(0, 40),
      teamId: optionalTruncatedText(event.audience.teamId, ACTIVITY_TEXT_LIMIT),
      visibility: event.audience.visibility
    }
  };
}

export function activityForPrincipal(entry: StoredLiveActivity, principal: LivePrincipal): PortalLiveActivity | undefined {
  if (!audienceAllowsPrincipal(entry.audience, principal)) {
    return undefined;
  }

  const directRecipient = entry.audience.recipientUserIds.includes(principal.id);
  return {
    ...entry.activity,
    priority: directRecipient || entry.audience.visibility === "private"
  };
}

export function activitiesForPrincipal(log: StoredLiveActivity[], principal: LivePrincipal, limit = 80) {
  return log
    .map((entry) => activityForPrincipal(entry, principal))
    .filter((activity): activity is PortalLiveActivity => Boolean(activity))
    .slice(0, limit);
}

export function onlinePeopleFromAttachments(attachments: SocketAttachment[], workspaceId: string): PortalLivePerson[] {
  const seen = new Set<string>();
  const people: PortalLivePerson[] = [];

  for (const attachment of attachments) {
    if (!attachment.subscribed || attachment.workspaceId !== workspaceId || seen.has(attachment.principal.id)) {
      continue;
    }

    seen.add(attachment.principal.id);
    const person: PortalLivePerson = {
      detail: "",
      id: attachment.principal.id,
      name: attachment.principal.name
    };
    if (attachment.principal.avatarUrl) {
      person.avatarUrl = attachment.principal.avatarUrl;
    }
    people.push(person);
  }

  return people;
}

export function storedActivityEquals(entry: StoredLiveActivity, event: PublishedLiveEvent) {
  return stableStringify(entry.activity) === stableStringify(event.activity)
    && stableStringify(entry.audience) === stableStringify(event.audience);
}

export function parseSocketAttachment(value: unknown): SocketAttachment | undefined {
  if (!isRecord(value) || !isRecord(value.principal)) {
    return undefined;
  }

  const workspaceId = normalizeWorkspaceId(value.workspaceId);
  const id = readString(value.principal.id).trim();
  const name = readString(value.principal.name).trim();
  if (!workspaceId || !id || !name) {
    return undefined;
  }

  return {
    connectionId: readString(value.connectionId) || crypto.randomUUID(),
    principal: {
      avatarUrl: readOptionalString(value.principal.avatarUrl),
      department: readOptionalString(value.principal.department),
      id,
      name,
      team: readOptionalString(value.principal.team),
      teamId: readOptionalString(value.principal.teamId)
    },
    subscribed: value.subscribed === true,
    workspaceId
  };
}

function audienceAllowsPrincipal(audience: LiveAudience, principal: LivePrincipal) {
  if (audience.visibility === "org" || audience.visibility === "public") {
    return true;
  }

  if (audience.recipientUserIds.includes(principal.id) || audience.actorUserId === principal.id) {
    return true;
  }

  return audience.visibility === "team" && (!audience.teamId || audience.teamId === principal.teamId);
}

function normalizeVisibility(value: unknown): LiveAudience["visibility"] {
  return value === "private" || value === "public" || value === "team" ? value : "org";
}

function compactMetadata(metadata: Record<string, unknown>) {
  const compact: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (!STORED_METADATA_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string") {
      compact[key] = truncateText(value, METADATA_TEXT_LIMIT);
    } else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) {
      compact[key] = value;
    } else if (Array.isArray(value)) {
      compact[key] = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => truncateText(item, ACTIVITY_TEXT_LIMIT))
        .filter(Boolean)
        .slice(0, 40);
    }
  }

  return compact;
}

function assignOptionalText<K extends keyof PortalLiveActivity>(
  target: PortalLiveActivity,
  key: K,
  value: PortalLiveActivity[K],
  limit: number
) {
  const compact = optionalTruncatedText(value, limit);
  if (compact !== undefined) {
    (target as Record<string, unknown>)[key] = compact;
  }
}

function assignOptionalUrl<K extends keyof PortalLiveActivity>(
  target: PortalLiveActivity,
  key: K,
  value: PortalLiveActivity[K],
  limit: number
) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text && text.length <= limit) {
    (target as Record<string, unknown>)[key] = text;
  }
}

function optionalTruncatedText(value: unknown, limit: number) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? truncateText(text, limit) : undefined;
}

function truncateText(value: unknown, limit: number) {
  const text = readString(value);
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function readStringList(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map(readString).map((item) => item.trim()).filter(Boolean))).slice(0, 200)
    : [];
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text || undefined;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
