import { useCallback, useEffect, useRef, useState } from "react";
import type { PortalCatalog } from "../../../../src/shared/types";
import type { LiveDataSource } from "../live/liveDataSource";

export type PortalNotification = {
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
  parentId?: string;
  parentType?: string;
  readAt?: string;
  status: "read" | "unread";
  summary: string;
  targetImageUrl?: string;
  targetName?: string;
};

type NotificationPayload = {
  notifications?: PortalNotification[];
  unreadCount?: number;
};

const NOTIFICATION_REFRESH_CACHE_MS = 30_000;

export function usePortalNotifications(dataSource: LiveDataSource, enabled = true) {
  const [notifications, setNotifications] = useState<PortalNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const loadedRef = useRef(false);
  const refreshedAtRef = useRef(0);
  const liveSignatureRef = useRef("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/notifications", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("notifications_load_failed");
      const payload = await response.json() as NotificationPayload;
      setNotifications(Array.isArray(payload.notifications) ? payload.notifications : []);
      setUnreadCount(Number.isFinite(payload.unreadCount) ? Number(payload.unreadCount) : 0);
      setError(false);
      loadedRef.current = true;
      refreshedAtRef.current = Date.now();
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || Date.now() - refreshedAtRef.current < NOTIFICATION_REFRESH_CACHE_MS) return undefined;
    void refresh();
    return undefined;
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || !dataSource.subscribe) return undefined;
    return dataSource.subscribe((snapshot) => {
      const signature = snapshot.activities
        .filter((activity) => activity.notificationId)
        .map((activity) => `${activity.notificationId}:${activity.unread ? "u" : "r"}`)
        .join("|");
      if (loadedRef.current && signature && signature !== liveSignatureRef.current) {
        liveSignatureRef.current = signature;
        void refresh();
      } else if (signature) {
        liveSignatureRef.current = signature;
      }
    });
  }, [dataSource, enabled, refresh]);

  const markRead = useCallback(async (notification: PortalNotification) => {
    if (notification.status !== "unread") return;
    const readAt = new Date().toISOString();
    setNotifications((current) => current.map((item) => (
      item.id === notification.id ? { ...item, status: "read", readAt } : item
    )));
    setUnreadCount((current) => Math.max(0, current - 1));
    await markPortalNotificationRead(notification.id);
  }, []);

  const markAllRead = useCallback(async () => {
    const readAt = new Date().toISOString();
    setNotifications((current) => current.map((item) => ({
      ...item,
      status: "read",
      readAt: item.readAt ?? readAt
    })));
    setUnreadCount(0);
    await fetch("/api/notifications/read", {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST"
    }).catch(() => undefined);
  }, []);

  const openNotification = useCallback(async (notification: PortalNotification) => {
    await markRead(notification);
    navigateToPortalNotification(notification);
  }, [markRead]);

  return {
    error,
    loading,
    markAllRead,
    markRead,
    notifications,
    openNotification,
    refresh,
    unreadCount
  };
}

export function enrichPortalNotification(
  notification: PortalNotification,
  catalog: Pick<PortalCatalog, "apps" | "hubListings" | "publicationListings" | "skills">
): PortalNotification {
  if (notification.notificationType !== "apps.review_approved") return notification;

  const listingId = metadataText(notification.metadata, "listingId") || notification.entityId;
  const targetIdFromMetadata = metadataText(notification.metadata, "targetId");
  const listingType = metadataText(notification.metadata, "listingType");
  const listing = [...catalog.hubListings, ...catalog.publicationListings].find((item) => (
    item.id === listingId || Boolean(targetIdFromMetadata) && item.targetId === targetIdFromMetadata
  ));
  const targetId = targetIdFromMetadata || listing?.targetId;
  const targetType = listingType || listing?.type;
  const target = targetType === "skill"
    ? catalog.skills.find((item) => item.id === targetId)
    : catalog.apps.find((item) => item.id === targetId);
  const targetImageUrl = listing?.coverImageUrl || target?.coverImageUrl;
  const targetName = listing?.name || target?.name || metadataText(notification.metadata, "listingName");

  return targetImageUrl || targetName
    ? { ...notification, targetImageUrl, targetName }
    : notification;
}

export function notificationUnreadBadge(unreadCount: number) {
  const count = normalizedUnreadCount(unreadCount);
  if (count <= 0) return undefined;
  return count > 99 ? "99+" : String(count);
}

function normalizedUnreadCount(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function metadataText(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

export async function markPortalNotificationRead(notificationId: string) {
  await fetch(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST" }).catch(() => undefined);
}

export function navigateToPortalNotification(notification: PortalNotification) {
  if (notification.href) {
    window.location.hash = notification.href.replace(/^#/, "");
  }
}
