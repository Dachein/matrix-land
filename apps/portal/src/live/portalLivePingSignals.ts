import {
  portalLiveActivityChannel,
  type PortalLiveActivity,
  type PortalLivePerson
} from "../../../../src/shared/portalLive";
import { activityStatus, localizedAgentActivitySummary } from "./agentActivityGroups";

export const PORTAL_LIVE_PROFILE_PROMPT_DELAY_MS = 60_000;

export type PortalLivePingState =
  | "failed"
  | "idle"
  | "jumping"
  | "review"
  | "running"
  | "running-left"
  | "running-right"
  | "waiting"
  | "waving";

export type PortalLivePingMotion = {
  intensity: PortalLivePingSignal["intensity"];
  reason:
    | "agent"
    | "community"
    | "fetch"
    | "idle"
    | "notification"
    | "rail-collapse"
    | "rail-expand"
    | "self-success";
  state: PortalLivePingState;
};

export type PortalLivePingSignal = {
  action: "href" | "none" | "notifications" | "open-mcp" | "open-profile";
  actorAvatarUrl?: string;
  actorName?: string;
  createdAt: string;
  href?: string;
  id: string;
  indicator:
    | "activity-avatar"
    | "agent-complete"
    | "agent-failed"
    | "agent-running"
    | "agent-waiting"
    | "mcp-connect"
    | "notification-avatar"
    | "notification-target"
    | "profile-avatar"
    | "profile-bio"
    | "presence-avatar";
  intensity: "active" | "ambient" | "urgent";
  kind: "activity" | "agent" | "notification" | "presence" | "profile";
  state: PortalLivePingState;
  summary: string;
};

export type PortalLivePingNotification = {
  actorAvatarUrl?: string;
  actorName: string;
  createdAt: string;
  id: string;
  notificationType: string;
  summary: string;
  targetImageUrl?: string;
  targetName?: string;
};

export type PortalLivePingOnlinePerson = {
  avatarUrl?: string;
  createdAt: string;
  id: string;
  name: string;
  signalId: string;
};

export function buildPortalLiveProfilePrompt({
  avatarSummary,
  avatarUrl,
  bio,
  bioSummary,
  hasMcpBadge,
  mcpSummary
}: {
  avatarSummary: string;
  avatarUrl?: string;
  bio?: string;
  bioSummary: string;
  hasMcpBadge: boolean;
  mcpSummary: string;
}): PortalLivePingSignal | undefined {
  if (!avatarUrl?.trim()) {
    return profilePromptSignal("avatar", avatarSummary);
  }

  if (!bio?.trim()) {
    return profilePromptSignal("bio", bioSummary);
  }

  if (!hasMcpBadge) {
    return profilePromptSignal("mcp", mcpSummary);
  }

  return undefined;
}

export function selectPortalLivePingSignals({
  now = Date.now(),
  profilePrompt,
  profilePromptDelayMs = PORTAL_LIVE_PROFILE_PROMPT_DELAY_MS,
  signals
}: {
  now?: number;
  profilePrompt?: PortalLivePingSignal;
  profilePromptDelayMs?: number;
  signals: PortalLivePingSignal[];
}) {
  if (!profilePrompt || signals[0]?.kind === "notification") {
    return signals;
  }

  const latestSignalTimestamp = signals[0] ? signalTimestamp(signals[0]) : 0;
  if (!latestSignalTimestamp || now - latestSignalTimestamp > profilePromptDelayMs) {
    return [profilePrompt];
  }

  return signals;
}

export function findNewTopTenOnlinePerson(
  previousTopTenIds: ReadonlySet<string>,
  onlinePeople: PortalLivePerson[]
) {
  return onlinePeople.slice(0, 10).find((person) => !previousTopTenIds.has(person.id));
}

export function isPortalLivePingSignalDismissed(
  signalId: string | undefined,
  dismissedSignalId: string | undefined,
  collapsed: boolean
) {
  return collapsed && Boolean(signalId && signalId === dismissedSignalId);
}

export function buildPortalLivePingSignals({
  activities,
  locale,
  multipleNotificationLabel,
  newOnlinePerson,
  newOnlineSummary,
  latestUnreadNotification,
  unreadCount
}: {
  activities: PortalLiveActivity[];
  locale: string;
  multipleNotificationLabel: string;
  newOnlinePerson?: PortalLivePingOnlinePerson;
  newOnlineSummary?: string;
  latestUnreadNotification?: PortalLivePingNotification;
  unreadCount: number;
}): PortalLivePingSignal[] {
  const signals: PortalLivePingSignal[] = [];
  const normalizedUnreadCount = Number.isFinite(unreadCount) ? Math.max(0, Math.floor(unreadCount)) : 0;
  const orderedActivities = [...activities]
    .sort((a, b) => activityTimestamp(b) - activityTimestamp(a));

  if (normalizedUnreadCount > 0) {
    const latestNotificationActivity = orderedActivities.find((activity) => activity.notificationId && activity.unread !== false);
    const approvedTarget = latestUnreadNotification?.notificationType === "apps.review_approved";
    return [{
      action: "notifications",
      actorAvatarUrl: approvedTarget
        ? latestUnreadNotification?.targetImageUrl
        : latestUnreadNotification?.actorAvatarUrl,
      actorName: approvedTarget
        ? latestUnreadNotification?.targetName
        : latestUnreadNotification?.actorName,
      createdAt: latestUnreadNotification?.createdAt ?? latestNotificationActivity?.createdAt ?? "",
      id: `notification:${latestUnreadNotification?.id ?? normalizedUnreadCount}`,
      indicator: approvedTarget ? "notification-target" : "notification-avatar",
      intensity: "urgent",
      kind: "notification",
      state: "waving",
      summary: normalizedUnreadCount === 1
        ? latestUnreadNotification?.summary || multipleNotificationLabel
        : multipleNotificationLabel
    }];
  }

  const latestAgentActivity = orderedActivities.find((activity) => portalLiveActivityChannel(activity) === "agent");
  const latestCommunityActivity = orderedActivities.find((activity) => {
    const channel = portalLiveActivityChannel(activity);
    return channel !== "agent" && !activity.notificationId;
  });

  if (latestAgentActivity) {
    signals.push(activitySignal(latestAgentActivity, locale));
  }

  if (newOnlinePerson && newOnlineSummary) {
    signals.push({
      action: "none",
      actorAvatarUrl: newOnlinePerson.avatarUrl,
      actorName: newOnlinePerson.name,
      createdAt: newOnlinePerson.createdAt,
      id: newOnlinePerson.signalId,
      indicator: "presence-avatar",
      intensity: "ambient",
      kind: "presence",
      state: "waving",
      summary: newOnlineSummary
    });
  }

  if (latestCommunityActivity) {
    signals.push(activitySignal(latestCommunityActivity, locale));
  }

  return signals.sort((a, b) => signalTimestamp(b) - signalTimestamp(a));
}

function activitySignal(activity: PortalLiveActivity, locale: string): PortalLivePingSignal {
  const agentActivity = portalLiveActivityChannel(activity) === "agent";
  return {
    action: activity.href ? "href" : "none",
    actorAvatarUrl: activity.actorAvatarUrl,
    actorName: activity.actorName,
    createdAt: activity.createdAt,
    href: activity.href,
    id: `activity:${activity.id}`,
    indicator: agentActivity ? agentIndicator(activity) : "activity-avatar",
    intensity: pingIntensityForActivity(activity),
    kind: agentActivity ? "agent" : "activity",
    state: pingStateForActivity(activity),
    summary: agentActivity ? localizedAgentActivitySummary(activity, locale) : activity.summary
  };
}

function agentIndicator(activity: PortalLiveActivity): PortalLivePingSignal["indicator"] {
  const status = activityStatus(activity);
  if (status === "succeeded") return "agent-complete";
  if (status === "failed") return "agent-failed";
  if (status === "blocked") return "agent-waiting";
  return "agent-running";
}

export function pingStateForActivity(activity: PortalLiveActivity): PortalLivePingState {
  const status = activityStatus(activity);
  if (status === "blocked") return "waiting";
  if (status === "failed") return "failed";
  if (status === "succeeded") return "jumping";
  if (activity.priority) return "waving";

  const channel = portalLiveActivityChannel(activity);
  if (channel === "agent") return "running";
  if (channel === "direct") return "waving";
  return "review";
}

export function pingIntensityForActivity(activity: PortalLiveActivity): PortalLivePingSignal["intensity"] {
  const status = activityStatus(activity);
  if (activity.priority || status === "blocked" || status === "failed") return "urgent";
  if (portalLiveActivityChannel(activity) === "agent" || status === "succeeded") return "active";
  return "ambient";
}

export function pingMotionForActivity(activity: PortalLiveActivity, currentUserId: string): PortalLivePingMotion {
  if (
    activity.actorUserId === currentUserId
    && (activity.eventType === "forum.topic.created" || activity.eventType === "forum.reply.created")
  ) {
    return { intensity: "active", reason: "self-success", state: "jumping" };
  }

  const agentActivity = portalLiveActivityChannel(activity) === "agent";
  return {
    intensity: pingIntensityForActivity(activity),
    reason: agentActivity ? "agent" : "community",
    state: pingStateForActivity(activity)
  };
}

function activityTimestamp(activity: PortalLiveActivity) {
  const timestamp = Date.parse(activity.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function signalTimestamp(signal: PortalLivePingSignal) {
  const timestamp = Date.parse(signal.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function profilePromptSignal(
  prompt: "avatar" | "bio" | "mcp",
  summary: string
): PortalLivePingSignal {
  return {
    action: prompt === "mcp" ? "open-mcp" : "open-profile",
    createdAt: "",
    id: `profile:${prompt}`,
    indicator: prompt === "avatar"
      ? "profile-avatar"
      : prompt === "bio"
        ? "profile-bio"
        : "mcp-connect",
    intensity: "ambient",
    kind: "profile",
    state: prompt === "mcp" ? "waving" : "review",
    summary
  };
}
