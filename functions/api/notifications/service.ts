import type { PortalCatalog } from "../../../src/shared/types";
import {
  schedulePortalLiveEvent,
  type PortalLivePublisherEnv
} from "../../../src/shared/portalLivePublisher.ts";
import { cacheableUserAvatarUrl } from "../users/avatar.ts";

type CurrentUser = PortalCatalog["currentUser"];

type NotificationsEnv = PortalLivePublisherEnv & {
  DB?: D1Database;
};

type NotificationsContext<TEnv extends NotificationsEnv> = EventContext<TEnv, string, unknown>;

type NotificationsDeps<TEnv extends NotificationsEnv> = {
  readBody<T>(request: Request): Promise<T>;
  requireDb(db: D1Database | undefined): D1Database;
  resolveCurrentUser(context: NotificationsContext<TEnv>): Promise<CurrentUser>;
};

const NOTIFICATION_LIST_LIMIT = 10;

export type NotificationItem = {
  actorAvatarUrl?: string;
  actorName: string;
  actorUserId: string;
  createdAt: string;
  entityId: string;
  entityType: string;
  href?: string;
  id: string;
  metadata: Record<string, unknown>;
  notificationType: string;
  postId?: string;
  topicId?: string;
  topicTitle?: string;
  parentId?: string;
  parentType?: string;
  readAt?: string;
  status: "read" | "unread";
  summary: string;
};

export function createNotificationsApi<TEnv extends NotificationsEnv>(deps: NotificationsDeps<TEnv>) {
  return {
    async listNotifications(context: NotificationsContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      return readNotifications(db, currentUser);
    },

    async markNotificationsRead(context: NotificationsContext<TEnv>, notificationId?: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<{ ids?: string[] }>(context.request);
      const ids = notificationId ? [notificationId] : sanitizeIds(body.ids);
      const updatedNotificationIds = ids.length > 0
        ? ids
        : await unreadNotificationIds(db, currentUser.id);

      if (ids.length > 0) {
        await db.batch(ids.map((id) => db
          .prepare(
            `
            UPDATE notifications
            SET status = 'read', read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
            WHERE id = ?
              AND recipient_user_id = ?
            `
          )
          .bind(id, currentUser.id)));
      } else {
        await db
          .prepare(
            `
            UPDATE notifications
            SET status = 'read', read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
            WHERE recipient_user_id = ?
              AND status != 'read'
            `
          )
          .bind(currentUser.id)
          .run();
      }

      updatedNotificationIds.forEach((id) => {
        schedulePortalLiveEvent(context, { notificationId: id });
      });
      return readNotifications(db, currentUser);
    }
  };
}

async function unreadNotificationIds(db: D1Database, recipientUserId: string) {
  const rows = await db
    .prepare(
      `
      SELECT id
      FROM notifications
      WHERE recipient_user_id = ?
        AND status != 'read'
      ORDER BY created_at DESC, id DESC
      LIMIT 100
      `
    )
    .bind(recipientUserId)
    .all<{ id?: string }>();

  return (rows.results ?? [])
    .map((row) => readString(row.id).trim())
    .filter(Boolean);
}

export async function readNotifications(db: D1Database, currentUser: CurrentUser) {
  const [rows, unreadRows] = await Promise.all([
    db.prepare(
      `
      SELECT
        notifications.id,
        notifications.actor_user_id AS actorUserId,
        COALESCE(actor.name, '') AS actorName,
        COALESCE(actor.avatar_url, '') AS actorAvatarUrl,
        notifications.notification_type AS notificationType,
        notifications.entity_type AS entityType,
        notifications.entity_id AS entityId,
        notifications.parent_type AS parentType,
        notifications.parent_id AS parentId,
        notifications.summary,
        notifications.href,
        notifications.metadata_json AS metadataJson,
        notifications.status,
        notifications.created_at AS createdAt,
        notifications.read_at AS readAt
      FROM notifications
      LEFT JOIN users AS actor ON actor.id = notifications.actor_user_id
      WHERE notifications.recipient_user_id = ?
      ORDER BY notifications.created_at DESC, notifications.id DESC
      LIMIT ${NOTIFICATION_LIST_LIMIT}
      `
    )
    .bind(currentUser.id)
    .all<Record<string, unknown>>(),
    db.prepare(
      `
      SELECT COUNT(*) AS unreadCount
      FROM notifications
      WHERE recipient_user_id = ?
        AND status = 'unread'
      `
    )
    .bind(currentUser.id)
    .all<Record<string, unknown>>()
  ]);

  const notifications = (rows.results ?? []).map(notificationFromRow);
  return {
    notifications,
    unreadCount: readNumber(unreadRows.results?.[0]?.unreadCount) || notifications.filter((notification) => notification.status === "unread").length
  };
}

function notificationFromRow(row: Record<string, unknown>): NotificationItem {
  return {
    actorAvatarUrl: cacheableUserAvatarUrl(row.actorUserId, row.actorAvatarUrl),
    actorName: readString(row.actorName),
    actorUserId: readString(row.actorUserId),
    createdAt: readString(row.createdAt),
    entityId: readString(row.entityId || row.postId || row.topicId),
    entityType: readString(row.entityType) || (row.postId ? "forum_post" : "forum_topic"),
    href: readOptionalString(row.href) || (readOptionalString(row.topicId) ? `#/posts/${encodeURIComponent(readString(row.topicId))}` : undefined),
    id: readString(row.id),
    metadata: { ...readJsonObject(row.metadataJson), ...(row.topicTitle ? { topicTitle: row.topicTitle } : {}) },
    notificationType: readString(row.notificationType) === "mention" ? "forum.mention" : readString(row.notificationType),
    postId: readOptionalString(row.postId) || (readString(row.entityType) === "forum_post" ? readOptionalString(row.entityId) : undefined),
    topicId: readOptionalString(row.topicId) || (readString(row.parentType) === "forum_topic" ? readOptionalString(row.parentId) : undefined),
    topicTitle: readOptionalString(row.topicTitle) || readOptionalString(readJsonObject(row.metadataJson).topicTitle),
    parentId: readOptionalString(row.parentId) || readOptionalString(row.topicId),
    parentType: readOptionalString(row.parentType) || (row.topicId ? "forum_topic" : undefined),
    readAt: readOptionalString(row.readAt),
    status: readString(row.status) === "read" ? "read" : "unread",
    summary: readString(row.summary) || fallbackNotificationSummary(row)
  };
}

function readJsonObject(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function fallbackNotificationSummary(row: Record<string, unknown>) {
  const actor = readString(row.actorName) || "Someone";
  const title = readOptionalString(row.topicTitle);
  return readString(row.notificationType) === "mention"
    ? `${actor} 提到了你${title ? `：《${title}》` : ""}`
    : `${actor} 给你发送了一条消息${title ? `：《${title}》` : ""}`;
}

function sanitizeIds(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map(readString).map((id) => id.trim()).filter(Boolean))).slice(0, 100)
    : [];
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text || undefined;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}
