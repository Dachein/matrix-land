import type { PortalLiveActivity } from "../../../../src/shared/portalLive";

export type AgentActivityGroup = {
  activity: PortalLiveActivity;
  count: number;
  failedCount: number;
  groupId: string;
  succeededCount: number;
};

const COMMUNITY_REACTION_GROUP_WINDOW_MS = 15 * 60 * 1000;

export function mergeRecentActivities(
  loadedActivities: PortalLiveActivity[],
  snapshotActivities: PortalLiveActivity[],
  limit = 30
) {
  const merged: PortalLiveActivity[] = [];
  const seenIds = new Set<string>();
  const seenTopics = new Set<string>();

  for (const activity of [...loadedActivities, ...snapshotActivities]) {
    const topicKey = forumTopicKey(activity);
    if (seenIds.has(activity.id) || topicKey && seenTopics.has(topicKey)) {
      continue;
    }
    seenIds.add(activity.id);
    if (topicKey) seenTopics.add(topicKey);
    merged.push(activity);
  }

  return merged
    .sort((left, right) => activityTime(right) - activityTime(left))
    .slice(0, Math.max(0, limit));
}

export function groupAgentActivities(activities: PortalLiveActivity[]): AgentActivityGroup[] {
  const groups = new Map<string, PortalLiveActivity[]>();

  activities.forEach((activity) => {
    const groupId = readOptionalString(activity.metadata?.groupId) ?? activity.id;
    groups.set(groupId, [...(groups.get(groupId) ?? []), activity]);
  });

  return Array.from(groups.entries())
    .map(([groupId, items]) => {
      const ordered = [...items].sort((a, b) => activityTime(b) - activityTime(a));
      const latest = ordered[0];
      const succeededCount = ordered.filter((activity) => activityStatus(activity) === "succeeded").length;
      const failedCount = ordered.filter((activity) => {
        const status = activityStatus(activity);
        return status === "blocked" || status === "failed";
      }).length;
      return {
        activity: latest,
        count: ordered.length,
        failedCount,
        groupId,
        succeededCount
      };
    })
    .sort((a, b) => activityTime(b.activity) - activityTime(a.activity));
}

export function latestActivityGroups<T extends { activity: PortalLiveActivity }>(groups: T[], limit = 30) {
  return [...groups]
    .sort((a, b) => activityTime(b.activity) - activityTime(a.activity))
    .slice(0, Math.max(0, limit));
}

export function groupCommunityActivities(activities: PortalLiveActivity[]): AgentActivityGroup[] {
  const ordered = [...activities].sort((a, b) => activityTime(b) - activityTime(a));
  const reactionGroups = new Map<string, AgentActivityGroup[]>();
  const groups: AgentActivityGroup[] = [];

  for (const activity of ordered) {
    const reactionKey = communityReactionKey(activity);
    if (!reactionKey) {
      groups.push(singleActivityGroup(activity));
      continue;
    }

    const candidates = reactionGroups.get(reactionKey) ?? [];
    const matching = candidates.find((group) => (
      activityTime(group.activity) - activityTime(activity) <= COMMUNITY_REACTION_GROUP_WINDOW_MS
    ));
    if (matching) {
      matching.count += 1;
      continue;
    }

    const group = singleActivityGroup(activity);
    candidates.push(group);
    reactionGroups.set(reactionKey, candidates);
    groups.push(group);
  }

  return groups.sort((a, b) => activityTime(b.activity) - activityTime(a.activity));
}

export function localizedAgentActivitySummary(activity: PortalLiveActivity, locale: string) {
  const localized = locale === "zh-CN"
    ? readOptionalString(activity.metadata?.activitySummaryZh)
    : readOptionalString(activity.metadata?.activitySummaryEn);
  return localized ?? activity.summary;
}

export function activityStatus(activity: PortalLiveActivity) {
  const status = readOptionalString(activity.metadata?.status);
  return status === "blocked" || status === "failed" || status === "succeeded" ? status : undefined;
}

function activityTime(activity: PortalLiveActivity) {
  const time = Date.parse(activity.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function communityReactionKey(activity: PortalLiveActivity) {
  if (activity.eventType !== "forum.reaction.created") {
    return undefined;
  }

  const actor = activity.actorUserId || activity.actorName;
  const topic = readOptionalString(activity.metadata?.parentId) || activity.href || activity.entityId;
  return actor && topic ? `${actor}|${activity.eventType}|${topic}|${activity.summary}` : undefined;
}

function forumTopicKey(activity: PortalLiveActivity) {
  if (activity.href) {
    const match = activity.href.match(/^#\/posts\/([^/?#]+)/);
    if (match?.[1]) {
      try {
        return `forum:${decodeURIComponent(match[1])}`;
      } catch {
        return `forum:${match[1]}`;
      }
    }
  }

  return activity.entityType === "forum_topic" && activity.entityId
    ? `forum:${activity.entityId}`
    : undefined;
}

function singleActivityGroup(activity: PortalLiveActivity): AgentActivityGroup {
  return {
    activity,
    count: 1,
    failedCount: 0,
    groupId: activity.id,
    succeededCount: 1
  };
}

function readOptionalString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}
