import {
  normalizePortalLiveHref,
  PORTAL_LIVE_PROTOCOL_VERSION,
  parsePortalLiveClientMessage,
  type PortalLiveAgent,
  type PortalLiveServerMessage
} from "../../../src/shared/portalLive";
import {
  activitiesForPrincipal,
  activityForPrincipal,
  appendStoredActivity,
  compactStoredActivityLog,
  normalizePublishedLiveEvent,
  normalizeWorkspaceId,
  onlinePeopleFromAttachments,
  parseSocketAttachment,
  type LivePrincipal,
  type PublishedLiveEvent,
  type SocketAttachment,
  type StoredLiveActivity
} from "./roomModels";

type Env = {
  AUTH_WORKER_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  DB?: D1Database;
  DEFAULT_WORKSPACE_ID?: string;
  DEV_AUTH_BYPASS?: string;
  LIVE_PUBLISH_TOKEN?: string;
  LIVE_ROOMS: DurableObjectNamespace;
  PORTAL_URL?: string;
};

type ActivityRow = {
  id?: unknown;
  actorAvatarUrl?: unknown;
  actorName?: unknown;
  actorTeam?: unknown;
  actorUserId?: unknown;
  actionType?: unknown;
  createdAt?: unknown;
  parentId?: unknown;
  parentTitle?: unknown;
  parentType?: unknown;
  href?: unknown;
  metadataJson?: unknown;
  scenario?: unknown;
  source?: unknown;
  sourceEventId?: unknown;
  summary?: unknown;
  teamId?: unknown;
  targetId?: unknown;
  targetTitle?: unknown;
  targetType?: unknown;
  visibility?: unknown;
};

type NotificationRow = {
  actorAvatarUrl?: unknown;
  actorName?: unknown;
  actorUserId?: unknown;
  createdAt?: unknown;
  entityId?: unknown;
  entityType?: unknown;
  href?: unknown;
  id?: unknown;
  metadataJson?: unknown;
  notificationType?: unknown;
  postId?: unknown;
  summary?: unknown;
  topicId?: unknown;
  topicTitle?: unknown;
  parentId?: unknown;
  parentType?: unknown;
  readAt?: unknown;
  recipientUserId?: unknown;
  status?: unknown;
};

const DEFAULT_WORKSPACE_ID = "workspace-ai-playground";
const ROOM_LOG_KEY = "portal-live:activity-log:v1";
const ROOM_SEQUENCE_KEY = "portal-live:sequence:v1";
const ROOM_POLL_INTERVAL_MS = 60_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return withCors(await handleRequest(request, env), request, env);
    } catch (error) {
      return withCors(errorResponse(error), request, env);
    }
  }
};

async function handleRequest(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (request.method === "GET" && path === "/health") {
    return json({ ok: true, protocolVersion: PORTAL_LIVE_PROTOCOL_VERSION, service: "workspace-portal-live" });
  }

  if (request.method === "GET" && path === "/v1/live") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new HttpError(426, "websocket_upgrade_required");
    }
    assertAllowedOrigin(request, env);
    const principal = await resolvePrincipal(request, env);
    const workspaceId = requestedWorkspaceId(url, env);
    return roomFetch(env, workspaceId, "/connect", principal, request.headers);
  }

  if (request.method === "GET" && path === "/v1/snapshot") {
    assertAllowedOrigin(request, env);
    const principal = await resolvePrincipal(request, env);
    const workspaceId = requestedWorkspaceId(url, env);
    return roomFetch(env, workspaceId, "/snapshot", principal);
  }

  if (request.method === "POST" && path === "/v1/events") {
    requirePublisher(request, env);
    const body = await readJson<Record<string, unknown>>(request);
    const workspaceId = normalizeWorkspaceId(body.workspaceId ?? env.DEFAULT_WORKSPACE_ID ?? DEFAULT_WORKSPACE_ID);
    const event = await publishedLiveEventFromRequest(env.DB, body);
    if (!workspaceId || !event) {
      throw new HttpError(400, "invalid_live_event");
    }

    const room = env.LIVE_ROOMS.get(env.LIVE_ROOMS.idFromName(workspaceId));
    return room.fetch(new Request(`https://portal-live-room/publish?workspaceId=${encodeURIComponent(workspaceId)}`, {
      body: JSON.stringify(event),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
  }

  throw new HttpError(404, "not_found");
}

export async function publishedLiveEventFromRequest(
  db: D1Database | undefined,
  body: Record<string, unknown>
) {
  const publishedEvent = normalizePublishedLiveEvent(body);
  if (publishedEvent) {
    return publishedEvent;
  }

  const activityEventId = readOptionalString(body.activityEventId);
  if (activityEventId && db) {
    const row = await db
      .prepare(
        `
        SELECT
          id,
          scenario,
          action_type AS actionType,
          actor_user_id AS actorUserId,
          actor_name AS actorName,
          actor_avatar_url AS actorAvatarUrl,
          actor_team AS actorTeam,
          target_type AS targetType,
          target_id AS targetId,
          target_title AS targetTitle,
          parent_type AS parentType,
          parent_id AS parentId,
          parent_title AS parentTitle,
          summary,
          href,
          visibility,
          team_id AS teamId,
          metadata_json AS metadataJson,
          source,
          source_event_id AS sourceEventId,
          created_at AS createdAt
        FROM activity_events
        WHERE id = ?
        LIMIT 1
        `
      )
      .bind(activityEventId)
      .first<ActivityRow>();
    return row ? liveEventFromActivityRow(row) : undefined;
  }

  const notificationId = readOptionalString(body.notificationId);
  if (notificationId && db) {
    const row = await db
      .prepare(
        `
        SELECT
          notifications.id,
          notifications.recipient_user_id AS recipientUserId,
          notifications.actor_user_id AS actorUserId,
          COALESCE(actor.name, '') AS actorName,
          COALESCE(actor.avatar_url, '') AS actorAvatarUrl,
          notifications.entity_id AS entityId,
          notifications.entity_type AS entityType,
          notifications.parent_id AS parentId,
          notifications.parent_type AS parentType,
          notifications.summary,
          notifications.href,
          notifications.metadata_json AS metadataJson,
          notifications.notification_type AS notificationType,
          notifications.status,
          notifications.created_at AS createdAt,
          notifications.read_at AS readAt
        FROM notifications
        LEFT JOIN users AS actor ON actor.id = notifications.actor_user_id
        WHERE notifications.id = ?
        LIMIT 1
        `
      )
      .bind(notificationId)
      .first<NotificationRow>();
    return row ? liveEventFromNotificationRow(row) : undefined;
  }

  return undefined;
}

export class PortalLiveRoom {
  private activityLog?: StoredLiveActivity[];
  private sequence?: number;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    try {
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch {
      // Older local runtimes may not expose auto-response while still supporting hibernation handlers.
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const workspaceId = normalizeWorkspaceId(url.searchParams.get("workspaceId"));
    if (!workspaceId) {
      return json({ error: "invalid_workspace" }, { status: 400 });
    }

    if (url.pathname === "/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket_upgrade_required" }, { status: 426 });
      }

      const principal = principalFromRoomRequest(request);
      if (!principal) {
        return json({ error: "not_authenticated" }, { status: 401 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const attachment: SocketAttachment = {
        connectionId: crypto.randomUUID(),
        principal,
        subscribed: false,
        workspaceId
      };
      server.serializeAttachment(attachment);
      this.state.acceptWebSocket(server);
      await this.scheduleAlarm();
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }

    if (url.pathname === "/snapshot" && request.method === "GET") {
      const principal = principalFromRoomRequest(request);
      if (!principal) {
        return json({ error: "not_authenticated" }, { status: 401 });
      }
      await this.syncFromDatabase();
      return json(this.snapshotMessage(principal, workspaceId));
    }

    if (url.pathname === "/publish" && request.method === "POST") {
      const event = normalizePublishedLiveEvent(await readJson(request));
      if (!event) {
        return json({ error: "invalid_live_event" }, { status: 400 });
      }

      const entry = await this.appendEvent(event);
      if (entry) {
        this.broadcastActivity(entry);
      }
      return json({ accepted: true, cursor: entry?.cursor ?? this.currentCursor() }, { status: 202 });
    }

    return json({ error: "not_found" }, { status: 404 });
  }

  async webSocketMessage(webSocket: WebSocket, rawMessage: string | ArrayBuffer) {
    const attachment = parseSocketAttachment(webSocket.deserializeAttachment());
    const message = typeof rawMessage === "string" ? parsePortalLiveClientMessage(rawMessage) : undefined;

    if (!attachment || !message) {
      this.send(webSocket, errorMessage("invalid_client_message", "A valid subscribe message is required."));
      webSocket.close(1008, "invalid_client_message");
      return;
    }

    if (message.workspaceId !== attachment.workspaceId) {
      this.send(webSocket, errorMessage("workspace_mismatch", "The subscription does not match this room."));
      webSocket.close(1008, "workspace_mismatch");
      return;
    }

    const subscribedAttachment = { ...attachment, subscribed: true };
    webSocket.serializeAttachment(subscribedAttachment);
    await this.syncFromDatabase();
    this.send(webSocket, this.snapshotMessage(subscribedAttachment.principal, subscribedAttachment.workspaceId));
    this.broadcastPresence(subscribedAttachment.workspaceId);
    await this.scheduleAlarm();
  }

  async webSocketClose(webSocket: WebSocket) {
    const attachment = parseSocketAttachment(webSocket.deserializeAttachment());
    if (attachment) {
      this.broadcastPresence(attachment.workspaceId, webSocket);
    }
  }

  async webSocketError(webSocket: WebSocket) {
    const attachment = parseSocketAttachment(webSocket.deserializeAttachment());
    if (attachment) {
      this.broadcastPresence(attachment.workspaceId, webSocket);
    }
  }

  async alarm() {
    const additions = await this.syncFromDatabase();
    additions.forEach((entry) => this.broadcastActivity(entry));
    this.broadcastHeartbeat();
    if (this.subscribedSockets().length > 0) {
      await this.scheduleAlarm();
    }
  }

  private async loadState() {
    if (!this.activityLog) {
      const storedLog = await this.state.storage.get<StoredLiveActivity[]>(ROOM_LOG_KEY) ?? [];
      this.activityLog = compactStoredActivityLog(storedLog);
    }
    if (this.sequence === undefined) {
      this.sequence = await this.state.storage.get<number>(ROOM_SEQUENCE_KEY) ?? 0;
    }
  }

  private async appendEvent(event: PublishedLiveEvent) {
    await this.loadState();
    const currentLog = this.activityLog ?? [];
    const sequence = (this.sequence ?? 0) + 1;
    const cursor = sequence.toString(36);
    const compactEvent = normalizePublishedLiveEvent(event) ?? event;
    const nextLog = appendStoredActivity(currentLog, compactEvent, cursor);
    if (nextLog === currentLog) {
      return undefined;
    }
    const entry: StoredLiveActivity = { ...compactEvent, cursor };
    this.activityLog = nextLog;
    this.sequence = sequence;
    await this.state.storage.put({
      [ROOM_LOG_KEY]: nextLog,
      [ROOM_SEQUENCE_KEY]: sequence
    });
    return entry;
  }

  private async syncFromDatabase() {
    if (!this.env.DB) {
      return [];
    }

    const events: Array<{ createdAt: string; event: PublishedLiveEvent }> = [];

    try {
      const result = await this.env.DB.prepare(`
        WITH recent_community AS (
          SELECT
            id,
            scenario,
            action_type AS actionType,
            actor_user_id AS actorUserId,
            actor_name AS actorName,
            actor_avatar_url AS actorAvatarUrl,
            actor_team AS actorTeam,
            target_type AS targetType,
            target_id AS targetId,
            target_title AS targetTitle,
            parent_type AS parentType,
            parent_id AS parentId,
            parent_title AS parentTitle,
            summary,
            href,
            visibility,
            team_id AS teamId,
            metadata_json AS metadataJson,
            source,
            source_event_id AS sourceEventId,
            created_at AS createdAt
          FROM activity_events
          WHERE scenario IN ('community', 'apps')
            AND NOT (
              scenario = 'agent'
              OR action_type LIKE 'agent.%'
              OR target_type = 'agent'
              OR source IN ('agent', 'workspace-mcp-worker')
            )
          ORDER BY created_at DESC, id DESC
          LIMIT 60
        ),
        recent_agent AS (
          SELECT
            id,
            scenario,
            action_type AS actionType,
            actor_user_id AS actorUserId,
            actor_name AS actorName,
            actor_avatar_url AS actorAvatarUrl,
            actor_team AS actorTeam,
            target_type AS targetType,
            target_id AS targetId,
            target_title AS targetTitle,
            parent_type AS parentType,
            parent_id AS parentId,
            parent_title AS parentTitle,
            summary,
            href,
            visibility,
            team_id AS teamId,
            metadata_json AS metadataJson,
            source,
            source_event_id AS sourceEventId,
            created_at AS createdAt
          FROM activity_events
          WHERE scenario = 'agent'
            OR action_type LIKE 'agent.%'
            OR target_type = 'agent'
            OR source IN ('agent', 'workspace-mcp-worker')
          ORDER BY created_at DESC, id DESC
          LIMIT 60
        )
        SELECT * FROM recent_community
        UNION ALL
        SELECT * FROM recent_agent
      `).all<ActivityRow>();
      for (const row of result.results ?? []) {
        const event = liveEventFromActivityRow(row);
        if (event) {
          events.push({ createdAt: readString(row.createdAt), event });
        }
      }
    } catch {
      // Keep Live available even if the activity projection has not been migrated yet.
    }

    // Notifications use their own read model and direct publisher, so polling must not
    // let them compete with the two 60-item Live feed windows.
    const additions: StoredLiveActivity[] = [];
    const orderedEvents = events.sort((a, b) => normalizeTimestamp(a.createdAt).localeCompare(normalizeTimestamp(b.createdAt)));
    for (const item of orderedEvents) {
      const event = item.event;
      const entry = await this.appendEvent(event);
      if (entry) {
        additions.push(entry);
      }
    }
    return additions;
  }

  private snapshotMessage(principal: LivePrincipal, workspaceId: string): PortalLiveServerMessage {
    return {
      activities: activitiesForPrincipal(this.activityLog ?? [], principal),
      cursor: this.currentCursor(),
      onlinePeople: this.onlinePeople(workspaceId),
      sentAt: new Date().toISOString(),
      type: "snapshot",
      version: PORTAL_LIVE_PROTOCOL_VERSION
    };
  }

  private broadcastActivity(entry: StoredLiveActivity) {
    for (const webSocket of this.subscribedSockets()) {
      const attachment = parseSocketAttachment(webSocket.deserializeAttachment());
      if (!attachment) {
        continue;
      }
      const activity = activityForPrincipal(entry, attachment.principal);
      if (!activity) {
        continue;
      }
      this.send(webSocket, {
        activity,
        cursor: entry.cursor,
        sentAt: new Date().toISOString(),
        type: "activity.upsert",
        version: PORTAL_LIVE_PROTOCOL_VERSION
      });
    }
  }

  private broadcastPresence(workspaceId: string, excluded?: WebSocket) {
    const onlinePeople = this.onlinePeople(workspaceId, excluded);
    const message: PortalLiveServerMessage = {
      cursor: this.currentCursor(),
      onlinePeople,
      sentAt: new Date().toISOString(),
      type: "presence.sync",
      version: PORTAL_LIVE_PROTOCOL_VERSION
    };
    this.subscribedSockets().forEach((webSocket) => {
      if (webSocket !== excluded) {
        this.send(webSocket, message);
      }
    });
  }

  private broadcastHeartbeat() {
    const message: PortalLiveServerMessage = {
      cursor: this.currentCursor(),
      sentAt: new Date().toISOString(),
      type: "heartbeat",
      version: PORTAL_LIVE_PROTOCOL_VERSION
    };
    this.subscribedSockets().forEach((webSocket) => this.send(webSocket, message));
  }

  private subscribedSockets() {
    return this.state.getWebSockets().filter((webSocket) => parseSocketAttachment(webSocket.deserializeAttachment())?.subscribed);
  }

  private onlinePeople(workspaceId: string, excluded?: WebSocket) {
    const attachments = this.state.getWebSockets()
      .filter((webSocket) => webSocket !== excluded)
      .map((webSocket) => parseSocketAttachment(webSocket.deserializeAttachment()))
      .filter((attachment): attachment is SocketAttachment => Boolean(attachment));
    return onlinePeopleFromAttachments(attachments, workspaceId);
  }

  private currentCursor() {
    return this.sequence && this.sequence > 0 ? this.sequence.toString(36) : undefined;
  }

  private send(webSocket: WebSocket, message: PortalLiveServerMessage) {
    try {
      webSocket.send(JSON.stringify(message));
    } catch {
      webSocket.close(1011, "send_failed");
    }
  }

  private async scheduleAlarm() {
    await this.state.storage.setAlarm(Date.now() + ROOM_POLL_INTERVAL_MS);
  }
}

export function liveEventFromActivityRow(row: ActivityRow): PublishedLiveEvent | undefined {
  const id = readString(row.id).trim();
  const actorName = readString(row.actorName).trim();
  const summary = readString(row.summary).trim();
  if (!id || !actorName || !summary) {
    return undefined;
  }

  const metadata = readJsonObject(row.metadataJson);
  const recipientUserIds = [
    readOptionalString(metadata.recipientUserId),
    ...readStringList(metadata.recipientUserIds)
  ].filter((value): value is string => Boolean(value));
  const actionType = readOptionalString(row.actionType);
  const targetType = readOptionalString(row.targetType);
  const targetId = readOptionalString(row.targetId);
  const agent = agentFromActivity(row, metadata);

  return {
    activity: {
      actorAvatarUrl: readOptionalString(row.actorAvatarUrl),
      actorName,
      actorUserId: readOptionalString(row.actorUserId),
      agent,
      channel: liveActivityChannel(actionType, targetType, metadata, recipientUserIds),
      createdAt: normalizeTimestamp(readString(row.createdAt)),
      entityId: targetId,
      entityType: targetType,
      eventType: actionType,
      href: normalizePortalLiveHref(readOptionalString(row.href)),
      id,
      metadata: {
        ...metadata,
        parentId: readOptionalString(row.parentId) ?? metadata.parentId,
        parentTitle: readOptionalString(row.parentTitle) ?? metadata.parentTitle,
        parentType: readOptionalString(row.parentType) ?? metadata.parentType,
        scenario: readOptionalString(row.scenario) ?? metadata.scenario,
        source: readOptionalString(row.source) ?? metadata.source,
        sourceEventId: readOptionalString(row.sourceEventId) ?? metadata.sourceEventId,
        targetTitle: readOptionalString(row.targetTitle) ?? metadata.targetTitle
      },
      priority: false,
      summary
    },
    audience: {
      actorUserId: readOptionalString(row.actorUserId),
      recipientUserIds: Array.from(new Set(recipientUserIds)),
      teamId: readOptionalString(row.teamId),
      visibility: normalizeVisibility(row.visibility)
    }
  };
}

export function liveEventFromNotificationRow(row: NotificationRow): PublishedLiveEvent | undefined {
  const id = readString(row.id).trim();
  const recipientUserId = readString(row.recipientUserId).trim();
  const actorName = readString(row.actorName).trim() || "Someone";
  if (!id || !recipientUserId) {
    return undefined;
  }

  const status = readString(row.status).trim().toLowerCase() === "read" ? "read" : "unread";
  const metadata = readJsonObject(row.metadataJson);
  const notificationType = readString(row.notificationType).trim() || "mention";
  const topicId = readOptionalString(row.topicId);
  const topicTitle = readOptionalString(row.topicTitle);
  const summary = readString(row.summary).trim() || notificationSummary(notificationType, actorName, {
    ...metadata,
    topicTitle: topicTitle ?? metadata.topicTitle
  });
  const entityId = readOptionalString(row.entityId) ?? readOptionalString(row.postId) ?? topicId;
  const entityType = readOptionalString(row.entityType) ?? (row.postId ? "forum_post" : "forum_topic");
  const parentId = readOptionalString(row.parentId) ?? topicId;

  return {
    activity: {
      actorAvatarUrl: readOptionalString(row.actorAvatarUrl),
      actorName,
      actorUserId: readOptionalString(row.actorUserId),
      channel: "direct",
      createdAt: normalizeTimestamp(readString(row.createdAt)),
      entityId,
      entityType,
      eventType: status === "read" ? "notification.read" : "notification.created",
      href: readOptionalString(row.href) ?? (topicId ? `#/posts/${encodeURIComponent(topicId)}` : undefined),
      id: `notification:${id}`,
      metadata: {
        notificationType,
        ...metadata,
        readAt: readOptionalString(row.readAt),
        status,
        targetUserId: recipientUserId,
        entityId,
        entityType,
        parentId,
        parentType: readOptionalString(row.parentType)
      },
      notificationId: id,
      priority: false,
      summary,
      unread: status !== "read"
    },
    audience: {
      actorUserId: readOptionalString(row.actorUserId),
      recipientUserIds: [recipientUserId],
      visibility: "private"
    }
  };
}

function notificationSummary(type: string, actorName: string, metadata: Record<string, unknown>) {
  const topicTitle = readOptionalString(metadata.topicTitle);
  const listingName = readOptionalString(metadata.listingName);
  if (type === "forum.mention" || type === "mention") {
    return `${actorName} 提到了你${topicTitle ? `：《${topicTitle}》` : ""}`;
  }
  if (type === "forum.thread_replied") {
    return `${actorName} 回复了你的帖子${topicTitle ? `《${topicTitle}》` : ""}`;
  }
  if (type === "forum.contributor_awarded") {
    const points = readOptionalString(metadata.points);
    return `${actorName} 给你的内容添加了社区贡献${points ? `（+${points}）` : ""}${topicTitle ? `：《${topicTitle}》` : ""}`;
  }
  if (type === "apps.review_approved") {
    return `APPS「${listingName || "产品"}」审核已通过`;
  }
  return `${actorName} 给你发送了一条消息`;
}

function liveActivityChannel(
  actionType: string | undefined,
  targetType: string | undefined,
  metadata: Record<string, unknown>,
  recipientUserIds: string[]
) {
  if (isAgentActivity(actionType, targetType, metadata)) {
    return "agent" as const;
  }

  return recipientUserIds.length > 0 ? "direct" as const : "community" as const;
}

function isAgentActivity(actionType: string | undefined, targetType: string | undefined, metadata: Record<string, unknown>) {
  return actionType?.startsWith("agent.") === true
    || targetType === "agent"
    || Boolean(readOptionalString(metadata.agentId) || readOptionalString(metadata.agentName) || readOptionalString(metadata.agentType));
}

function agentFromActivity(row: ActivityRow, metadata: Record<string, unknown>): PortalLiveAgent | undefined {
  if (!isAgentActivity(readOptionalString(row.actionType), readOptionalString(row.targetType), metadata)) {
    return undefined;
  }

  const agentId = readOptionalString(metadata.agentId) ?? (readOptionalString(row.targetType) === "agent" ? readOptionalString(row.targetId) : undefined);
  const agentName = readOptionalString(metadata.agentName) ?? (readOptionalString(row.targetType) === "agent" ? readOptionalString(row.targetTitle) : undefined);

  return {
    id: agentId,
    name: agentName,
    type: normalizeAgentType(metadata.agentType ?? agentName ?? agentId)
  };
}

function requestedWorkspaceId(url: URL, env: Env) {
  const workspaceId = normalizeWorkspaceId(url.searchParams.get("workspaceId") ?? env.DEFAULT_WORKSPACE_ID ?? DEFAULT_WORKSPACE_ID);
  if (!workspaceId) {
    throw new HttpError(400, "invalid_workspace");
  }
  return workspaceId;
}

function roomFetch(env: Env, workspaceId: string, path: string, principal: LivePrincipal, sourceHeaders?: Headers) {
  const room = env.LIVE_ROOMS.get(env.LIVE_ROOMS.idFromName(workspaceId));
  const headers = new Headers(sourceHeaders);
  headers.set("x-portal-live-principal", encodeURIComponent(JSON.stringify(principal)));
  return room.fetch(new Request(`https://portal-live-room${path}?workspaceId=${encodeURIComponent(workspaceId)}`, { headers }));
}

function principalFromRoomRequest(request: Request): LivePrincipal | undefined {
  const value = request.headers.get("x-portal-live-principal");
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const id = readString(parsed.id).trim();
    const name = readString(parsed.name).trim();
    return id && name ? {
      avatarUrl: readOptionalString(parsed.avatarUrl),
      department: readOptionalString(parsed.department),
      id,
      name,
      team: readOptionalString(parsed.team),
      teamId: readOptionalString(parsed.teamId)
    } : undefined;
  } catch {
    return undefined;
  }
}

async function resolvePrincipal(request: Request, env: Env): Promise<LivePrincipal> {
  if (env.DEV_AUTH_BYPASS === "1" && isLocalRequest(request)) {
    return {
      department: "AI Adoption",
      id: "local-dev-admin",
      name: "Local Admin",
      team: "AI Adoption",
      teamId: "team-ai-adoption"
    };
  }

  const cookie = request.headers.get("cookie");
  if (!cookie || !env.AUTH_WORKER_URL?.trim()) {
    throw new HttpError(401, "not_authenticated");
  }

  const response = await fetch(`${env.AUTH_WORKER_URL.replace(/\/+$/, "")}/auth/session`, {
    headers: { Accept: "application/json", cookie }
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  const user = isRecord(payload.user) ? payload.user : undefined;
  if (!response.ok || payload.authenticated !== true || !user) {
    throw new HttpError(401, "not_authenticated");
  }

  const id = readString(user.id ?? user.sub).trim();
  const name = readString(user.name ?? user.displayName).trim();
  if (!id || !name) {
    throw new HttpError(401, "invalid_session_user");
  }

  return {
    avatarUrl: readOptionalString(user.avatarUrl),
    department: readOptionalString(user.department),
    id,
    name,
    team: readOptionalString(user.team),
    teamId: readOptionalString(user.teamId)
  };
}

function requirePublisher(request: Request, env: Env) {
  const expected = env.LIVE_PUBLISH_TOKEN?.trim();
  if (!expected) {
    throw new HttpError(503, "live_publish_token_not_configured");
  }
  const provided = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
    || request.headers.get("x-portal-live-token")?.trim();
  if (provided !== expected) {
    throw new HttpError(401, "invalid_live_publish_token");
  }
}

function assertAllowedOrigin(request: Request, env: Env) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return;
  }
  if (isLocalOrigin(origin) && (env.DEV_AUTH_BYPASS === "1" || !request.headers.has("cf-ray"))) {
    return;
  }
  if (!allowedOrigins(env).has(origin)) {
    throw new HttpError(403, "origin_not_allowed");
  }
}

function allowedOrigins(env: Env) {
  const origins = new Set<string>();
  [env.PORTAL_URL, env.CORS_ALLOWED_ORIGINS]
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => originFromUrl(value.trim()))
    .filter(Boolean)
    .forEach((origin) => origins.add(origin));
  return origins;
}

function withCors(response: Response, request: Request, env: Env) {
  if ((response as Response & { webSocket?: WebSocket }).webSocket) {
    return response;
  }

  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin");
  if (origin && (allowedOrigins(env).has(origin) || isLocalOrigin(origin))) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("vary", "Origin");
  }
  headers.set("access-control-allow-headers", "Authorization, Content-Type, X-Portal-Live-Token");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}

function errorMessage(code: string, message: string): PortalLiveServerMessage {
  return {
    code,
    message,
    sentAt: new Date().toISOString(),
    type: "error",
    version: PORTAL_LIVE_PROTOCOL_VERSION
  };
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof HttpError) {
    return json({ error: error.code }, { status: error.status });
  }
  return json({ error: "portal_live_worker_error" }, { status: 500 });
}

async function readJson<T = unknown>(request: Request): Promise<T> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return {} as T;
  }
  return request.json() as Promise<T>;
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers }
  });
}

function normalizePath(value: string) {
  const path = value.replace(/\/+$/, "");
  return path || "/";
}

function normalizeVisibility(value: unknown) {
  return value === "private" || value === "public" || value === "team" ? value : "org";
}

function normalizeTimestamp(value: string) {
  if (!value) {
    return new Date().toISOString();
  }
  if (value.includes("T")) {
    return value;
  }
  return `${value.replace(" ", "T")}Z`;
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

function readJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readStringList(value: unknown) {
  return Array.isArray(value) ? value.map(readString).map((item) => item.trim()).filter(Boolean) : [];
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

function isLocalRequest(request: Request) {
  const urlHostname = new URL(request.url).hostname.toLowerCase();
  const hostHeader = (request.headers.get("host") ?? "").split(":")[0]?.toLowerCase() ?? "";
  return isLocalHostname(urlHostname) || isLocalHostname(hostHeader) || !request.headers.has("cf-ray");
}

function isLocalOrigin(origin: string) {
  try {
    return isLocalHostname(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isLocalHostname(hostname: string) {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

function originFromUrl(value: string) {
  if (!value) {
    return "";
  }
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}
