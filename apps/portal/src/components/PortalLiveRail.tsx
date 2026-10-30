import { Bot, CheckCheck, Radio, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  type McpConnection,
  type McpConnectionStatus,
  type McpConnectionStatusMode
} from "../../../../src/portal/components/McpConnectionModal";
import { Button } from "../../../../src/portal/components/Button";
import type { ProfileModalUser } from "../../../../src/portal/components/ProfileModal";
import { PersonAvatar } from "../../../../src/portal/components/shared/avatar";
import { RelativeTime } from "../../../../src/portal/components/shared/time";
import { ProfileAvatarButton } from "../../../../src/portal/forum/components/ForumProfile";
import { communityLevelLabel } from "../../../../src/portal/forum/profileModels";
import { subscribeToUserJourneyProjectionUpdates } from "../../../../src/portal/lib/userJourneyProjectionEvents";
import { useI18n } from "../../../../src/portal/i18n";
import workspaceMcpIcon from "../../../../src/assets/workspace-pass-mcp.svg";
import workBuddyIcon from "../../../../src/assets/agent-brands/workbuddy-color.svg";
import claudeIcon from "../../../../src/assets/model-brands/claude-color.svg";
import cursorIcon from "../../../../src/assets/model-brands/cursor.svg";
import openAiIcon from "../../../../src/assets/model-brands/openai.svg";
import { portalLiveActivityChannel, type PortalLiveActivity } from "../../../../src/shared/portalLive";
import type { ActivityEvent, PortalCatalog } from "../../../../src/shared/types";
import { activityFromCatalogEvent, type LiveDataSource } from "../live/liveDataSource";
import {
  activityStatus,
  groupAgentActivities,
  groupCommunityActivities,
  latestActivityGroups,
  mergeRecentActivities,
  localizedAgentActivitySummary
} from "../live/agentActivityGroups";
import { notificationUnreadBadge, type PortalNotification } from "./PortalNotifications";
import { PortalLivePing } from "./PortalLivePing";
import {
  loadOnlineUserProfiles,
  onlineUserLevelLabel,
  type OnlineUserProfile
} from "../live/onlineUserProfiles";

const ONLINE_PEOPLE_DISPLAY_LIMIT = 10;
const ACTIVITY_DISPLAY_LIMIT = 10;
const ACTIVITY_FETCH_LIMIT = 30;
const ACTIVITY_MERGE_LIMIT = 80;
const ACTIVITY_VIEW_CACHE_MS = 30_000;
export type PortalLiveActivityChannel = "agent" | "community" | "notification";

export function PortalLiveRail({
  activityChannel,
  collapsed,
  currentUser,
  currentUserHasMcpBadge,
  currentUserJourneyLevel,
  dataSource,
  hidden = false,
  mcpConnectionStatus,
  mcpStatusMode,
  notificationUnreadCount,
  notifications,
  notificationsError,
  notificationsLoading,
  onActivityChannelChange,
  onMarkAllNotificationsRead,
  onNotificationAction,
  onNotificationOpen,
  onOpenMcp,
  onOpenProfile,
  onToggle
}: {
  activityChannel: PortalLiveActivityChannel;
  collapsed: boolean;
  currentUser: PortalCatalog["currentUser"];
  currentUserHasMcpBadge: boolean;
  currentUserJourneyLevel?: PortalCatalog["journey"]["level"];
  dataSource: LiveDataSource;
  hidden?: boolean;
  mcpConnectionStatus: McpConnectionStatus;
  mcpStatusMode: McpConnectionStatusMode;
  notificationUnreadCount: number;
  notifications: PortalNotification[];
  notificationsError: boolean;
  notificationsLoading: boolean;
  onActivityChannelChange: (channel: PortalLiveActivityChannel) => void;
  onMarkAllNotificationsRead: () => void;
  onNotificationAction: () => void;
  onNotificationOpen: (notification: PortalNotification) => void;
  onOpenMcp: () => void;
  onOpenProfile: () => void;
  onToggle: () => void;
}) {
  const { locale, t } = useI18n();
  const snapshot = useLiveSnapshot(dataSource);
  const [activityEventCache, setActivityEventCache] = useState<Record<string, ActivityEvent[]>>({});
  const activityFetchedAtRef = useRef(new Map<string, number>());
  const requestedScenario = activityChannel === "notification" ? undefined : activityChannel;
  const activityCacheKey = requestedScenario ? `${currentUser.id}:${requestedScenario}` : "";
  useEffect(() => {
    if (collapsed || hidden || !requestedScenario) return undefined;
    if (Date.now() - (activityFetchedAtRef.current.get(activityCacheKey) ?? 0) < ACTIVITY_VIEW_CACHE_MS) {
      return undefined;
    }

    let cancelled = false;
    const controller = new AbortController();
    const loadTimer = window.setTimeout(() => {
      void fetch(`/api/activity/events?scenario=${requestedScenario}&limit=${ACTIVITY_FETCH_LIMIT}`, {
        headers: { accept: "application/json" },
        signal: controller.signal
      }).then(async (response) => {
        if (!response.ok) throw new Error("activity_events_load_failed");
        return response.json() as Promise<{ events?: ActivityEvent[] }>;
      }).then((payload) => {
        if (cancelled) return;
        setActivityEventCache((current) => ({
          ...current,
          [activityCacheKey]: Array.isArray(payload.events) ? payload.events.slice(0, ACTIVITY_FETCH_LIMIT) : []
        }));
        activityFetchedAtRef.current.set(activityCacheKey, Date.now());
      }).catch(() => undefined);
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(loadTimer);
      controller.abort();
    };
  }, [activityCacheKey, collapsed, hidden, requestedScenario]);
  const activities = useMemo(() => {
    const recentActivityEvents = activityEventCache[activityCacheKey] ?? [];
    const loadedEvents = recentActivityEvents.map((event) => activityFromCatalogEvent(event, currentUser.id));
    return mergeRecentActivities(loadedEvents, snapshot.activities, ACTIVITY_MERGE_LIMIT);
  }, [activityCacheKey, activityEventCache, currentUser.id, snapshot.activities]);
  const visibleOnlinePeople = useMemo(
    () => snapshot.onlinePeople.slice(0, ONLINE_PEOPLE_DISPLAY_LIMIT),
    [snapshot.onlinePeople]
  );
  const activeAgentConnections = useMemo(() => activeMcpConnections(mcpConnectionStatus), [mcpConnectionStatus]);
  const agentActivities = useMemo(
    () => activities.filter((activity) => portalLiveActivityChannel(activity) === "agent"),
    [activities]
  );
  const agentActivityGroups = useMemo(
    () => latestActivityGroups(groupAgentActivities(agentActivities), ACTIVITY_DISPLAY_LIMIT),
    [agentActivities]
  );
  const communityActivities = useMemo(
    () => activities.filter((activity) => {
      const channel = portalLiveActivityChannel(activity);
      return channel === "community" || channel === "direct" && !activity.notificationId;
    }),
    [activities]
  );
  const communityActivityGroups = useMemo(() => latestActivityGroups(
    groupCommunityActivities(communityActivities), ACTIVITY_DISPLAY_LIMIT
  ), [communityActivities]);
  const visibleActivities = activityChannel === "agent"
    ? agentActivityGroups
    : communityActivityGroups;
  const profileUserIds = useMemo(() => {
    if (collapsed || hidden) return [];
    return Array.from(new Set([
      ...notifications.slice(0, 10).map((notification) => notification.actorUserId),
      ...visibleOnlinePeople.map((person) => person.id),
      ...visibleActivities.map((group) => group.activity.actorUserId ?? "")
    ].filter(Boolean))).slice(0, 100);
  }, [collapsed, hidden, notifications, visibleActivities, visibleOnlinePeople]);
  const userProfiles = useUserProfiles(profileUserIds);
  const enrichedOnlinePeople = useMemo(() => visibleOnlinePeople.map((person) => {
    const profile = userProfiles.get(person.id);
    return {
      ...person,
      avatarUrl: profile?.avatarUrl ?? person.avatarUrl,
      name: profile?.name ?? person.name
    };
  }), [userProfiles, visibleOnlinePeople]);
  const enrichedPingActivities = useMemo(() => activities.map((activity) => {
    const profile = activity.actorUserId ? userProfiles.get(activity.actorUserId) : undefined;
    return {
      ...activity,
      actorAvatarUrl: profile?.avatarUrl ?? activity.actorAvatarUrl,
      actorName: profile?.name ?? activity.actorName
    };
  }), [activities, userProfiles]);
  const enrichedNotifications = useMemo(() => notifications.map((notification) => {
    const profile = userProfiles.get(notification.actorUserId);
    return {
      ...notification,
      actorAvatarUrl: profile?.avatarUrl ?? notification.actorAvatarUrl,
      actorName: profile?.name ?? notification.actorName
    };
  }), [notifications, userProfiles]);
  const latestUnreadNotification = enrichedNotifications.find((notification) => notification.status === "unread");
  const profileHoverContext = useMemo(() => ({
    currentUserEmail: currentUser.email.toLowerCase(),
    currentUserId: currentUser.id,
    currentUserLevelLabel: communityLevelLabel(currentUserJourneyLevel?.key, locale)
  }), [currentUser.email, currentUser.id, currentUserJourneyLevel?.key, locale]);
  return (
    <aside aria-label={t("portal.live.aria")} className="portal-live-rail" hidden={hidden}>
      <div className="portal-live-header">
        <div className="portal-live-header-copy">
          <PortalLivePing
            activities={enrichedPingActivities}
            collapsed={collapsed}
            connectionState={snapshot.connectionState}
            currentUserAvatarUrl={currentUser.avatarUrl}
            currentUserBio={currentUser.bio}
            currentUserHasMcpBadge={currentUserHasMcpBadge}
            currentUserId={currentUser.id}
            latestUnreadNotification={latestUnreadNotification}
            onOpenMcp={onOpenMcp}
            onOpenProfile={onOpenProfile}
            onNotificationAction={onNotificationAction}
            onToggle={onToggle}
            onlinePeople={enrichedOnlinePeople}
            updateKey={snapshot.cursor}
            unreadCount={notificationUnreadCount}
          />
        </div>
      </div>

      <div className="portal-live-body">
        <section className="portal-live-section">
          <div className="portal-live-section-header">
            <p className="portal-rail-label">{t("portal.live.agentConnection")}</p>
            <button
              aria-label={t("portal.live.agentSettings")}
              className="portal-icon-button portal-live-settings"
              onClick={onOpenMcp}
              title={t("portal.live.agentSettings")}
              type="button"
            >
              <Settings size={15} />
            </button>
          </div>
          {activeAgentConnections.length > 0 ? (
            <div className="portal-agent-connection-list">
              {activeAgentConnections.map((connection) => (
                <button
                  className="portal-agent-connection"
                  key={connection.id}
                  onClick={() => onActivityChannelChange("agent")}
                  type="button"
                >
                  <AgentIcon connection={connection} />
                  <span>
                    <strong>{agentConnectionName(connection)}</strong>
                    <small>{connection.lastSeenAt || connection.updatedAt || connection.createdAt ? (
                      <RelativeTime value={connection.lastSeenAt || connection.updatedAt || connection.createdAt || ""} />
                    ) : mcpConnectionLabel(mcpStatusMode, mcpConnectionStatus, t)}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : mcpConnectionStatus.connected ? (
            <Button
              className="portal-agent-empty connected"
              iconBefore={<img alt="" aria-hidden="true" className="portal-agent-empty-logo" src={workspaceMcpIcon} />}
              onClick={onOpenMcp}
              variant="secondary"
            >
              <span>{mcpConnectionLabel(mcpStatusMode, mcpConnectionStatus, t)}</span>
            </Button>
          ) : (
            <Button
              className="portal-agent-empty"
              iconBefore={<img alt="" aria-hidden="true" className="portal-agent-empty-logo" src={workspaceMcpIcon} />}
              onClick={onOpenMcp}
              variant="secondary"
            >
              <span>{t("portal.live.agentEmptyAction")}</span>
            </Button>
          )}
        </section>

        <section className="portal-live-section">
          <p className="portal-rail-label">{t("portal.live.onlineNow")}</p>
          <div className="portal-online-list">
            {visibleOnlinePeople.map((person) => {
              const profile = userProfiles.get(person.id);
              const name = profile?.name ?? person.name;
              const levelLabel = onlineUserLevelLabel(profile?.journeyLevelKey, locale);
              const profileUser = onlineProfileUser(profile, {
                avatarUrl: person.avatarUrl,
                id: person.id,
                name: person.name
              });

              return (
                <div className="portal-online-person" key={person.id}>
                  <span className="portal-online-avatar">
                    <ProfileAvatarButton profileHoverContext={profileHoverContext} user={profileUser} />
                    <span className="portal-online-indicator" aria-label={t("portal.live.onlineStatus")} />
                  </span>
                  <span>
                    <strong>{name}</strong>
                    {levelLabel && <small>{levelLabel}</small>}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className={`portal-live-section portal-live-feed ${activityChannel === "notification" ? "notification-active" : ""}`}>
          <div className="portal-live-section-header">
            <p className="portal-rail-label">{t("portal.live.activities")}</p>
            <div className="portal-live-tabs" role="group" aria-label={t("portal.live.activities")}>
              <button
                aria-pressed={activityChannel === "community"}
                className={activityChannel === "community" ? "active" : ""}
                onClick={() => onActivityChannelChange("community")}
                type="button"
              >
                {t("portal.live.communityTab")}
              </button>
              <button
                aria-pressed={activityChannel === "notification"}
                className={activityChannel === "notification" ? "active" : ""}
                onClick={() => onActivityChannelChange("notification")}
                type="button"
              >
                {t("portal.live.notificationTab")}
                {notificationUnreadCount > 0 && <span>[{notificationUnreadBadge(notificationUnreadCount)}]</span>}
              </button>
              <button
                aria-pressed={activityChannel === "agent"}
                className={activityChannel === "agent" ? "active" : ""}
                onClick={() => onActivityChannelChange("agent")}
                type="button"
              >
                {t("portal.live.agentTab")}
              </button>
            </div>
          </div>
          {activityChannel === "notification" ? (
            <div className="portal-live-notification-list">
              {notificationUnreadCount > 0 && (
                <button className="portal-live-notification-read-all" onClick={onMarkAllNotificationsRead} type="button">
                  <CheckCheck size={14} />
                  <span>{t("portal.notifications.markAllRead")}</span>
                </button>
              )}
              {notificationsLoading && <p className="portal-live-notification-state">{t("portal.notifications.loading")}</p>}
              {!notificationsLoading && notificationsError && <p className="portal-live-notification-state">{t("portal.notifications.error")}</p>}
              {!notificationsLoading && !notificationsError && enrichedNotifications.length === 0 && (
                <p className="portal-live-notification-state">{t("portal.notifications.empty")}</p>
              )}
              {!notificationsLoading && !notificationsError && enrichedNotifications.map((notification) => {
                const approvedTarget = notification.notificationType === "apps.review_approved";
                const imageUrl = approvedTarget ? notification.targetImageUrl : notification.actorAvatarUrl;
                const name = approvedTarget
                  ? notification.targetName || notification.actorName
                  : notification.actorName;
                return (
                  <button
                    className={`portal-live-notification-item ${notification.status === "unread" ? "unread" : ""}`}
                    key={notification.id}
                    onClick={() => onNotificationOpen(notification)}
                    type="button"
                  >
                    <PersonAvatar imageUrl={imageUrl} name={name || "Workspace"} />
                    <span className="portal-live-notification-copy">
                      <strong>{notification.summary}</strong>
                      <small>
                        <RelativeTime value={notification.createdAt} />
                        {notification.status === "unread" && <em>{t("portal.notifications.unread")}</em>}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="portal-live-activity-list">
            {visibleActivities.length > 0 ? visibleActivities.map((group) => {
              const activity = group.activity;
              const actorProfile = activity.actorUserId ? userProfiles.get(activity.actorUserId) : undefined;
              const actorUser = activity.actorUserId ? onlineProfileUser(actorProfile, {
                avatarUrl: activity.actorAvatarUrl,
                id: activity.actorUserId,
                name: activity.actorName
              }) : undefined;
              const agentActivity = portalLiveActivityChannel(activity) === "agent";
              const status = activityStatus(activity);

              return (
                <div
                  className={`portal-live-activity ${activity.priority ? "priority" : ""} ${portalLiveActivityChannel(activity)} ${status ? `status-${status}` : ""}`}
                  key={group.groupId}
                >
                  {agentActivity ? (
                    <AgentActivityIcon activity={activity} />
                  ) : actorUser ? (
                    <ProfileAvatarButton profileHoverContext={profileHoverContext} user={actorUser} />
                  ) : (
                    <PersonAvatar imageUrl={activity.actorAvatarUrl} name={activity.actorName} />
                  )}
                  <a className="portal-live-activity-link" href={activity.href || "#discussions"}>
                    <strong>{agentActivity ? localizedAgentActivitySummary(activity, locale) : activity.summary}</strong>
                    <small>
                      {agentActivity && (
                        <>
                          <span>{activity.agent?.name || agentLabel(activity.agent?.type)}</span>
                          {group.count > 1 && <span> · {t("portal.live.agentOperationCount", { count: group.count })}</span>}
                          {status && <span> · {agentActivityStatusLabel(status, t)}</span>}
                          <span> · </span>
                        </>
                      )}
                      <RelativeTime value={activity.createdAt} />
                    </small>
                  </a>
                </div>
              );
            }) : (
              <div className="portal-live-empty">
                {activityChannel === "agent" ? <Bot size={16} /> : <Radio size={16} />}
                <span>{activityChannel === "agent" ? t("portal.live.agentEmpty") : t("portal.live.empty")}</span>
              </div>
            )}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function AgentActivityIcon({ activity }: { activity: PortalLiveActivity }) {
  const src = agentIconSrc(activity.agent?.type);
  if (src) {
    return <span className="portal-live-agent-avatar"><img alt="" src={src} /></span>;
  }

  return <span className="portal-live-agent-avatar fallback" aria-hidden="true"><Bot size={17} /></span>;
}

function agentActivityStatusLabel(
  status: "blocked" | "failed" | "succeeded",
  t: ReturnType<typeof useI18n>["t"]
) {
  if (status === "blocked") return t("portal.live.agentStatus.blocked");
  if (status === "failed") return t("portal.live.agentStatus.failed");
  return t("portal.live.agentStatus.succeeded");
}

function activeMcpConnections(status: McpConnectionStatus) {
  return status.connections
    .filter((connection) => connection.status === "active")
    .sort((a, b) => liveConnectionTime(b).localeCompare(liveConnectionTime(a)));
}

function liveConnectionTime(connection: McpConnection) {
  return connection.lastSeenAt || connection.updatedAt || connection.createdAt || "";
}

function agentConnectionName(connection: McpConnection) {
  return connection.displayName?.trim() || agentLabel(connection.agentType);
}

function AgentIcon({ connection }: { connection: McpConnection }) {
  const src = agentIconSrc(connection.agentType);
  if (src) {
    return <img alt="" className="portal-agent-icon" src={src} />;
  }

  return <span className="portal-agent-icon fallback" aria-hidden="true">{agentLabel(connection.agentType).at(0) ?? "A"}</span>;
}

function agentLabel(agent: McpConnection["agentType"] | string | undefined) {
  if (agent === "claude-code") return "Claude";
  if (agent === "workbuddy") return "WorkBuddy";
  if (agent === "cursor") return "Cursor";
  if (agent === "codex") return "Codex";
  return "ChatGPT";
}

function agentIconSrc(agent: McpConnection["agentType"] | string | undefined) {
  if (agent === "claude-code") return claudeIcon;
  if (agent === "workbuddy") return workBuddyIcon;
  if (agent === "cursor") return cursorIcon;
  if (agent === "codex" || agent === "chatgpt") return openAiIcon;
  return undefined;
}

function useLiveSnapshot(dataSource: LiveDataSource) {
  const subscribe = useCallback((notify: () => void) => (
    dataSource.subscribe ? dataSource.subscribe(() => notify()) : () => undefined
  ), [dataSource]);
  const getSnapshot = useCallback(() => dataSource.getSnapshot(), [dataSource]);

  useEffect(() => {
    dataSource.start?.();
    return () => dataSource.stop?.();
  }, [dataSource]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useUserProfiles(userIds: string[]) {
  const [profiles, setProfiles] = useState<Map<string, OnlineUserProfile>>(() => new Map());
  const profilesRef = useRef(profiles);
  const normalizedUserIds = useMemo(() => Array.from(new Set(
    userIds.map((id) => id.trim()).filter(Boolean)
  )), [userIds]);
  const userIdsKey = normalizedUserIds.join("\u001f");

  useEffect(() => {
    const missingUserIds = normalizedUserIds.filter((id) => !profilesRef.current.has(id));
    if (missingUserIds.length === 0) {
      return undefined;
    }

    const controller = new AbortController();

    void loadOnlineUserProfiles(missingUserIds, controller.signal)
      .then((users) => {
        if (!controller.signal.aborted) {
          const nextProfiles = new Map(profilesRef.current);
          users.forEach((user) => nextProfiles.set(user.id, user));
          profilesRef.current = nextProfiles;
          setProfiles(nextProfiles);
        }
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [userIdsKey]);

  useEffect(() => subscribeToUserJourneyProjectionUpdates((update) => {
    const profile = profilesRef.current.get(update.id);
    if (!profile) {
      return;
    }

    const nextProfiles = new Map(profilesRef.current);
    nextProfiles.set(update.id, { ...profile, ...update });
    profilesRef.current = nextProfiles;
    setProfiles(nextProfiles);
  }), []);

  return profiles;
}

function onlineProfileUser(
  profile: OnlineUserProfile | undefined,
  fallback: { avatarUrl?: string; id: string; name: string; team?: string }
): ProfileModalUser {
  return {
    id: profile?.id ?? fallback.id,
    name: profile?.name ?? fallback.name,
    email: profile?.email ?? "",
    avatarUrl: profile?.avatarUrl ?? fallback.avatarUrl,
    team: "",
    department: profile?.department,
    jobTitle: profile?.jobTitle,
    bio: profile?.bio,
    journeyCommunityContributionPoints: profile?.journeyCommunityContributionPoints,
    journeyLevelKey: profile?.journeyLevelKey,
    journeyTotalPoints: profile?.journeyTotalPoints,
    role: "member"
  };
}

function mcpConnectionLabel(
  mode: McpConnectionStatusMode,
  status: McpConnectionStatus,
  t: ReturnType<typeof useI18n>["t"]
) {
  if (mode === "loading") {
    return t("layout.mcp.statusChecking");
  }

  if (mode === "error") {
    return status.connected ? t("layout.mcp.statusConnected") : t("layout.mcp.statusUnknown");
  }

  return status.connected ? t("layout.mcp.statusConnected") : t("layout.mcp.statusDisconnected");
}
