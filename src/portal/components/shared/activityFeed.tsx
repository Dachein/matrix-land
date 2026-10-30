import { MessageCircle } from "lucide-react";
import type { ActivityEvent } from "../../../shared/types";
import { useI18n, type Locale } from "../../i18n";
import { PersonAvatar } from "./avatar";
import { RelativeTime, timestampMs } from "./time";

type Translate = ReturnType<typeof useI18n>["t"];

type ActivityEventGroup = {
  actorCount: number;
  event: ActivityEvent;
  key: string;
  summary: string;
};

export function ActivityLine({ text }: { text: string }) {
  return (
    <span className="activityLine">
      <i className="pulseDot" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

export function ActivityEventList({ emptyText, events, limit = 5 }: { emptyText?: string; events: ActivityEvent[]; limit?: number }) {
  const { locale, t } = useI18n();
  const visibleEvents = groupActivityEvents(events, t, locale).slice(0, limit);

  if (visibleEvents.length === 0) {
    return <div className="activityEventEmpty">{emptyText ?? t("activity.empty")}</div>;
  }

  return (
    <div className="activityEventList">
      {visibleEvents.map((group) => {
        const event = group.event;
        const body = (
          <>
            <PersonAvatar imageUrl={event.actorAvatarUrl} name={event.actorName} />
            <span className="activityEventText">
              <strong>{group.summary}</strong>
              <small><RelativeTime value={event.createdAt} fallback={event.createdAt} /></small>
            </span>
          </>
        );

        return event.href ? (
          <a className="activityEventItem" href={event.href} key={group.key}>
            {body}
          </a>
        ) : (
          <div className="activityEventItem" key={group.key}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

export function DiscussionSignal({ replies, views }: { replies: number; views: number }) {
  const { t } = useI18n();

  return (
    <span className="discussionSignal">
      <MessageCircle size={14} />
      {t("ui.discussionSignal", { replies, views })}
    </span>
  );
}

function groupActivityEvents(events: ActivityEvent[], t: Translate, locale: Locale): ActivityEventGroup[] {
  const orderedEvents = [...events].sort((a, b) => (timestampMs(b.createdAt) ?? 0) - (timestampMs(a.createdAt) ?? 0));
  const groups = new Map<string, { actorKeys: Set<string>; actorCount: number; event: ActivityEvent; key: string }>();

  orderedEvents.forEach((event) => {
    const key = activityEventGroupKey(event);
    let group = groups.get(key);

    if (!group) {
      group = { actorKeys: new Set<string>(), actorCount: 0, event, key };
      groups.set(key, group);
    }

    const actorKey = event.actorUserId || event.actorName;

    if (actorKey && !group.actorKeys.has(actorKey)) {
      group.actorKeys.add(actorKey);
      group.actorCount += 1;
    }
  });

  return Array.from(groups.values()).map((group) => {
    const actorLabel = activityActorLabel(group.event.actorName, group.actorCount, t);

    return {
      actorCount: group.actorCount,
      event: group.event,
      key: group.key,
      summary: activityEventSummary(group.event, actorLabel, t, locale)
    };
  });
}

function activityEventGroupKey(event: ActivityEvent) {
  if (event.actionType === "forum.reply.created") {
    return `${event.actionType}:${event.parentType ?? event.targetType}:${event.parentId ?? event.targetId}`;
  }

  if (event.actionType === "forum.reaction.created") {
    return `${event.actionType}:${event.targetType}:${event.targetId}`;
  }

  return event.id;
}

function activityActorLabel(actorName: string, actorCount: number, t: Translate) {
  if (actorCount <= 1) {
    return actorName;
  }

  const otherCount = actorCount - 1;
  const otherLabel = t(otherCount === 1 ? "ui.activityOtherOne" : "ui.activityOtherMany", { count: otherCount });
  return t("ui.activityActorGroup", { actorName, count: actorCount, otherLabel });
}

function activityEventSummary(event: ActivityEvent, actorLabel: string, t: Translate, locale: Locale) {
  const targetTitle = event.actionType === "forum.reply.created" || event.actionType === "forum.reaction.created"
    ? event.parentTitle || event.targetTitle
    : event.targetTitle;
  const target = localizedActivityTarget(event, locale) || targetTitle || "";

  switch (event.actionType) {
    case "community.member.joined":
      return t("ui.activity.communityJoined", { actor: actorLabel });
    case "journey.badge.awarded":
      return t("ui.activity.badgeAwarded", { actor: actorLabel, target });
    case "journey.level.upgraded":
      return t("ui.activity.levelUpgraded", { actor: actorLabel, rank: activityMetadataText(event, "levelRank"), target });
    case "forum.topic.created":
      return t("ui.activity.topicCreated", { actor: actorLabel, target });
    case "forum.reply.created":
      return t("ui.activity.replyCreated", { actor: actorLabel, target });
    case "forum.reaction.created":
      return t("ui.activity.reactionCreated", { actor: actorLabel, target });
    case "apps.app.published":
      return t("ui.activity.appPublished", { actor: actorLabel, target });
    default:
      return event.summary;
  }
}

function localizedActivityTarget(event: ActivityEvent, locale: Locale) {
  if (event.actionType === "journey.badge.awarded") {
    return locale === "zh-CN"
      ? activityMetadataText(event, "badgeNameZh") || event.targetTitle
      : activityMetadataText(event, "badgeNameEn") || event.targetTitle;
  }

  if (event.actionType === "journey.level.upgraded") {
    return locale === "zh-CN"
      ? activityMetadataText(event, "levelNameZh") || event.targetTitle
      : activityMetadataText(event, "levelNameEn") || event.targetTitle;
  }

  return event.targetTitle;
}

function activityMetadataText(event: ActivityEvent, key: string) {
  const value = event.metadata?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
