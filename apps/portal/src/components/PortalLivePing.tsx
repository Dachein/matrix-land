import {
  Check,
  FileText,
  Hourglass,
  LoaderCircle,
  PlugZap,
  Radio,
  TriangleAlert,
  UserRound
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PersonAvatar } from "../../../../src/portal/components/shared/avatar";
import { RelativeTime } from "../../../../src/portal/components/shared/time";
import { useI18n } from "../../../../src/portal/i18n";
import type { PortalLiveActivity } from "../../../../src/shared/portalLive";
import workspacePingFailed from "../assets/workspace-ping/failed.gif";
import workspacePingIdle from "../assets/workspace-ping/idle.gif";
import workspacePingJumping from "../assets/workspace-ping/jumping.gif";
import workspacePingReview from "../assets/workspace-ping/review.gif";
import workspacePingRunningLeft from "../assets/workspace-ping/running-left.gif";
import workspacePingRunningRight from "../assets/workspace-ping/running-right.gif";
import workspacePingRunning from "../assets/workspace-ping/running.gif";
import workspacePingWaiting from "../assets/workspace-ping/waiting.gif";
import workspacePingWaving from "../assets/workspace-ping/waving.gif";
import type { LiveConnectionState, LivePerson } from "../live/liveDataSource";
import {
  PORTAL_LIVE_PROFILE_PROMPT_DELAY_MS,
  buildPortalLiveProfilePrompt,
  buildPortalLivePingSignals,
  findNewTopTenOnlinePerson,
  isPortalLivePingSignalDismissed,
  pingMotionForActivity,
  selectPortalLivePingSignals,
  type PortalLivePingMotion,
  type PortalLivePingOnlinePerson,
  type PortalLivePingSignal,
  type PortalLivePingState
} from "../live/portalLivePingSignals";
import { notificationUnreadBadge, type PortalNotification } from "./PortalNotifications";

const PING_ANIMATION: Record<PortalLivePingState, string> = {
  failed: workspacePingFailed,
  idle: workspacePingIdle,
  jumping: workspacePingJumping,
  review: workspacePingReview,
  running: workspacePingRunning,
  "running-left": workspacePingRunningLeft,
  "running-right": workspacePingRunningRight,
  waiting: workspacePingWaiting,
  waving: workspacePingWaving
};

export function PortalLivePing({
  activities,
  collapsed,
  connectionState,
  currentUserAvatarUrl,
  currentUserBio,
  currentUserHasMcpBadge,
  currentUserId,
  latestUnreadNotification,
  onOpenMcp,
  onOpenProfile,
  onNotificationAction,
  onToggle,
  onlinePeople,
  updateKey,
  unreadCount
}: {
  activities: PortalLiveActivity[];
  collapsed: boolean;
  connectionState: LiveConnectionState;
  currentUserAvatarUrl?: string;
  currentUserBio?: string;
  currentUserHasMcpBadge: boolean;
  currentUserId: string;
  latestUnreadNotification?: PortalNotification;
  onOpenMcp: () => void;
  onOpenProfile: () => void;
  onNotificationAction: () => void;
  onToggle: () => void;
  onlinePeople: LivePerson[];
  updateKey?: string;
  unreadCount: number;
}) {
  const { locale, t } = useI18n();
  const [newOnlinePerson, setNewOnlinePerson] = useState<PortalLivePingOnlinePerson>();
  const onlinePeopleRef = useRef(new Set<string>());
  const onlineBaselineReadyRef = useRef(false);
  const onlineSignalSequenceRef = useRef(0);

  useEffect(() => {
    const topOnlinePeople = onlinePeople.slice(0, 10);
    const topOnlineIds = new Set(topOnlinePeople.map((person) => person.id));
    setNewOnlinePerson((current) => {
      if (!current) return current;
      const refreshed = topOnlinePeople.find((person) => person.id === current.id);
      if (!refreshed || refreshed.avatarUrl === current.avatarUrl && refreshed.name === current.name) return current;
      return { ...current, avatarUrl: refreshed.avatarUrl, name: refreshed.name };
    });
    if (!onlineBaselineReadyRef.current) {
      onlinePeopleRef.current = topOnlineIds;
      onlineBaselineReadyRef.current = connectionState === "connected";
      return;
    }

    if (connectionState !== "connected") return;

    const newlyOnline = findNewTopTenOnlinePerson(onlinePeopleRef.current, topOnlinePeople);
    onlinePeopleRef.current = topOnlineIds;
    if (!newlyOnline) return;

    onlineSignalSequenceRef.current += 1;
    setNewOnlinePerson({
      avatarUrl: newlyOnline.avatarUrl,
      createdAt: new Date().toISOString(),
      id: newlyOnline.id,
      name: newlyOnline.name,
      signalId: `presence:${newlyOnline.id}:${onlineSignalSequenceRef.current}`
    });
  }, [connectionState, onlinePeople]);

  const liveSignals = useMemo(() => buildPortalLivePingSignals({
    activities,
    locale,
    multipleNotificationLabel: t("portal.live.ping.unreadNotifications", { count: unreadCount }),
    newOnlinePerson,
    newOnlineSummary: newOnlinePerson
      ? t("portal.live.ping.onlinePerson", { name: newOnlinePerson.name })
      : undefined,
    latestUnreadNotification,
    unreadCount
  }), [activities, latestUnreadNotification, locale, newOnlinePerson, t, unreadCount]);
  const profilePrompt = useMemo(() => buildPortalLiveProfilePrompt({
    avatarSummary: t("portal.live.ping.profileAvatar"),
    avatarUrl: currentUserAvatarUrl,
    bio: currentUserBio,
    bioSummary: t("portal.live.ping.profileBio"),
    hasMcpBadge: currentUserHasMcpBadge,
    mcpSummary: t("portal.live.ping.profileMcp")
  }), [currentUserAvatarUrl, currentUserBio, currentUserHasMcpBadge, t]);
  const [signalClock, setSignalClock] = useState(() => Date.now());

  useEffect(() => {
    const now = Date.now();
    setSignalClock(now);
    if (!profilePrompt || liveSignals[0]?.kind === "notification") return undefined;

    const latestSignalTimestamp = Date.parse(liveSignals[0]?.createdAt ?? "");
    if (!Number.isFinite(latestSignalTimestamp)) return undefined;

    const refreshAfterMs = latestSignalTimestamp + PORTAL_LIVE_PROFILE_PROMPT_DELAY_MS - now + 1;
    if (refreshAfterMs <= 0) return undefined;

    const timer = window.setTimeout(() => setSignalClock(Date.now()), refreshAfterMs);
    return () => window.clearTimeout(timer);
  }, [liveSignals, profilePrompt]);

  const signals = useMemo(() => selectPortalLivePingSignals({
    now: signalClock,
    profilePrompt,
    signals: liveSignals
  }), [liveSignals, profilePrompt, signalClock]);
  const signalSignature = signals.map((signal) => signal.id).join("|");
  const [motion, setMotion] = useState<PortalLivePingMotion>();
  const [motionNonce, setMotionNonce] = useState(0);
  const [dismissedSignalId, setDismissedSignalId] = useState<string>();
  const idleWalkStartsLeftRef = useRef(true);
  const previousLiveStateRef = useRef({
    activityIds: new Set(activities.map((activity) => activity.id)),
    collapsed,
    notificationId: latestUnreadNotification?.id,
    unreadCount,
    updateKey
  });

  useEffect(() => {
    const previous = previousLiveStateRef.current;
    const newActivities = activities
      .filter((activity) => !previous.activityIds.has(activity.id))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    let nextMotion: PortalLivePingMotion | undefined;

    if (
      unreadCount > previous.unreadCount
      || unreadCount > 0 && latestUnreadNotification?.id !== previous.notificationId
    ) {
      nextMotion = { intensity: "urgent", reason: "notification", state: "waving" };
    } else if (collapsed !== previous.collapsed) {
      nextMotion = collapsed
        ? { intensity: "active", reason: "rail-collapse", state: "running-left" }
        : { intensity: "active", reason: "rail-expand", state: "running-right" };
    } else if (newActivities[0]) {
      nextMotion = pingMotionForActivity(newActivities[0], currentUserId);
    } else if (updateKey && updateKey !== previous.updateKey) {
      nextMotion = { intensity: "ambient", reason: "fetch", state: "review" };
    }

    previousLiveStateRef.current = {
      activityIds: new Set(activities.map((activity) => activity.id)),
      collapsed,
      notificationId: latestUnreadNotification?.id,
      unreadCount,
      updateKey
    };

    if (!nextMotion) return undefined;

    setMotion(nextMotion);
    setMotionNonce((current) => current + 1);
    const timer = window.setTimeout(() => setMotion(undefined), motionDuration(nextMotion));
    return () => window.clearTimeout(timer);
  }, [activities, collapsed, currentUserId, latestUnreadNotification?.id, unreadCount, updateKey]);

  useEffect(() => {
    if (connectionState !== "connected") return undefined;

    let returnTimer: number | undefined;
    let settleTimer: number | undefined;
    const interval = window.setInterval(() => {
      const startsLeft = idleWalkStartsLeftRef.current;
      setMotion({
        intensity: "ambient",
        reason: "idle",
        state: startsLeft ? "running-left" : "running-right"
      });
      setMotionNonce((current) => current + 1);
      returnTimer = window.setTimeout(() => {
        setMotion({
          intensity: "ambient",
          reason: "idle",
          state: startsLeft ? "running-right" : "running-left"
        });
        setMotionNonce((current) => current + 1);
      }, 1300);
      settleTimer = window.setTimeout(() => setMotion(undefined), 2700);
      idleWalkStartsLeftRef.current = !startsLeft;
    }, 45000);

    return () => {
      window.clearInterval(interval);
      if (returnTimer) window.clearTimeout(returnTimer);
      if (settleTimer) window.clearTimeout(settleTimer);
    };
  }, [collapsed, connectionState, signalSignature, updateKey]);

  const signal = signals[0];
  const signalDismissed = isPortalLivePingSignalDismissed(signal?.id, dismissedSignalId, collapsed);
  const signalVisible = Boolean(signal && !signalDismissed);
  const state = motion?.state ?? quietPingState(connectionState);
  const quietLabel = connectionLabel(connectionState, t);
  const unreadBadge = notificationUnreadBadge(unreadCount);
  const pingActionLabel = collapsed ? t("portal.live.open") : t("portal.live.close");

  return (
    <div
      className={`portal-live-ping ${signalVisible ? "has-signal" : signalDismissed ? "is-dismissed" : "is-quiet"}`}
      data-ping-intensity={motion?.intensity ?? signal?.intensity ?? "ambient"}
      data-ping-reason={motion?.reason ?? "quiet"}
      data-ping-state={state}
    >
      <button
        aria-label={pingActionLabel}
        className="portal-live-ping-avatar"
        aria-expanded={!collapsed}
        onClick={onToggle}
        title={pingActionLabel}
        type="button"
      >
        <img alt="" key={`${state}:${motionNonce}`} src={PING_ANIMATION[state]} />
        <span className={`portal-live-ping-status ${connectionState}`} aria-hidden="true" />
        {unreadBadge && <strong className="portal-live-ping-count">{unreadBadge}</strong>}
      </button>
      <div aria-live="polite" className="portal-live-ping-message">
        {signalVisible && signal ? (
          <PingSignalBubble
            key={signal.id}
            dismissible={collapsed}
            onDismiss={() => setDismissedSignalId(signal.id)}
            onMcpAction={onOpenMcp}
            onNotificationAction={onNotificationAction}
            onProfileAction={onOpenProfile}
            signal={signal}
          />
        ) : !signal ? (
          <div className="portal-live-ping-bubble quiet">
            <span className="portal-live-ping-bubble-copy">
              <span className="portal-live-ping-bubble-line">
                <strong>{t("portal.live.ping.name")}</strong>
                <i aria-hidden="true">·</i>
                <span>{quietLabel}</span>
              </span>
            </span>
            <span aria-hidden="true" className="portal-live-ping-indicator neutral"><Radio size={16} /></span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PingSignalBubble({
  dismissible,
  onDismiss,
  onMcpAction,
  onNotificationAction,
  onProfileAction,
  signal
}: {
  dismissible: boolean;
  onDismiss: () => void;
  onMcpAction: () => void;
  onNotificationAction: () => void;
  onProfileAction: () => void;
  signal: PortalLivePingSignal;
}) {
  const { t } = useI18n();
  const content = (
    <>
      <span className="portal-live-ping-bubble-copy">
        <span className="portal-live-ping-bubble-line">
          <strong>{pingKindLabel(signal.kind, t)}</strong>
          <i aria-hidden="true">·</i>
          <span>{signal.summary}</span>
        </span>
        {signal.createdAt && <small><RelativeTime value={signal.createdAt} /></small>}
      </span>
      <PingSignalIndicator signal={signal} />
    </>
  );

  if (signal.action === "href" && signal.href) {
    return (
      <a
        className={`portal-live-ping-bubble ${signal.kind} ${signal.intensity}`}
        href={signal.href}
        onClick={dismissible ? onDismiss : undefined}
      >
        {content}
      </a>
    );
  }

  if (signal.action === "none") {
    if (dismissible) {
      return (
        <button
          className={`portal-live-ping-bubble ${signal.kind} ${signal.intensity}`}
          onClick={onDismiss}
          type="button"
        >
          {content}
        </button>
      );
    }
    return <div className={`portal-live-ping-bubble ${signal.kind} ${signal.intensity}`}>{content}</div>;
  }

  if (signal.action === "open-mcp" || signal.action === "open-profile") {
    return (
      <button
        className={`portal-live-ping-bubble ${signal.kind} ${signal.intensity}`}
        onClick={() => {
          if (dismissible) onDismiss();
          if (signal.action === "open-mcp") onMcpAction();
          else onProfileAction();
        }}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <button
      className={`portal-live-ping-bubble ${signal.kind} ${signal.intensity}`}
      onClick={() => {
        if (dismissible) onDismiss();
        onNotificationAction();
      }}
      type="button"
    >
      {content}
    </button>
  );
}

function PingSignalIndicator({ signal }: { signal: PortalLivePingSignal }) {
  if (
    signal.indicator === "activity-avatar"
    || signal.indicator === "presence-avatar"
    || signal.indicator === "notification-avatar"
    || signal.indicator === "notification-target"
  ) {
    return (
      <span className={`portal-live-ping-indicator avatar ${signal.indicator}`}>
        <PersonAvatar imageUrl={signal.actorAvatarUrl} name={signal.actorName || "Workspace"} />
      </span>
    );
  }

  let icon: ReactNode;
  if (signal.indicator === "agent-complete") icon = <Check size={18} />;
  else if (signal.indicator === "agent-failed") icon = <TriangleAlert size={17} />;
  else if (signal.indicator === "agent-waiting") icon = <Hourglass size={16} />;
  else if (signal.indicator === "agent-running") icon = <LoaderCircle className="spin" size={17} />;
  else if (signal.indicator === "profile-avatar") icon = <UserRound size={17} />;
  else if (signal.indicator === "profile-bio") icon = <FileText size={16} />;
  else if (signal.indicator === "mcp-connect") icon = <PlugZap size={16} />;
  else icon = <Radio size={16} />;

  return <span aria-hidden="true" className={`portal-live-ping-indicator ${signal.indicator}`}>{icon}</span>;
}

function quietPingState(connectionState: LiveConnectionState): PortalLivePingState {
  return connectionState === "connected" ? "idle" : "waiting";
}

function motionDuration(motion: Pick<PortalLivePingMotion, "intensity">) {
  if (motion.intensity === "urgent") return 3200;
  if (motion.intensity === "active") return 2400;
  return 1500;
}

function pingKindLabel(kind: PortalLivePingSignal["kind"], t: ReturnType<typeof useI18n>["t"]) {
  if (kind === "notification") return t("portal.live.ping.notification");
  if (kind === "agent") return t("portal.live.ping.agent");
  if (kind === "presence") return t("portal.live.ping.presence");
  if (kind === "profile") return t("portal.live.ping.profile");
  return t("portal.live.ping.activity");
}

function connectionLabel(state: LiveConnectionState, t: ReturnType<typeof useI18n>["t"]) {
  if (state === "connected") return t("portal.live.connection.connected");
  if (state === "connecting") return t("portal.live.connection.connecting");
  if (state === "reconnecting") return t("portal.live.connection.reconnecting");
  return t("portal.live.connection.offline");
}
