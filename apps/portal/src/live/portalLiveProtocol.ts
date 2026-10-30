import {
  PORTAL_LIVE_PROTOCOL_VERSION,
  parsePortalLiveClientMessage,
  parsePortalLiveServerMessage,
  portalLiveActivityChannel,
  type PortalLiveClientMessage,
  type PortalLiveServerMessage
} from "../../../../src/shared/portalLive";
import type { LiveSnapshot } from "./liveDataSource";

export {
  normalizePortalLiveHref,
  PORTAL_LIVE_PROTOCOL_VERSION,
  parsePortalLiveClientMessage,
  parsePortalLiveServerMessage,
  type PortalLiveClientMessage,
  type PortalLiveServerMessage
} from "../../../../src/shared/portalLive";

export function reducePortalLiveMessage(snapshot: LiveSnapshot, message: PortalLiveServerMessage): LiveSnapshot {
  const cursor = message.cursor ?? snapshot.cursor;

  switch (message.type) {
    case "snapshot": {
      const nextActivities = dedupeActivities([
        ...message.activities.map((activity) => preserveActivityAvatar(activity, snapshot.activities)),
        ...snapshot.activities
      ]);
      const nextPeople = preservePeopleAvatars(dedupePeople(message.onlinePeople), snapshot.onlinePeople);
      return connectedSnapshot(snapshot, cursor, {
        activities: sameValues(nextActivities, snapshot.activities) ? snapshot.activities : nextActivities,
        onlinePeople: sameValues(nextPeople, snapshot.onlinePeople) ? snapshot.onlinePeople : nextPeople
      });
    }
    case "activity.upsert": {
      const activity = preserveActivityAvatar(message.activity, snapshot.activities);
      const existing = snapshot.activities.find((candidate) => candidate.id === activity.id);
      const activities = existing && sameValues(existing, activity)
        ? snapshot.activities
        : dedupeActivities([activity, ...snapshot.activities]);
      return connectedSnapshot(snapshot, cursor, { activities });
    }
    case "presence.sync": {
      const nextPeople = preservePeopleAvatars(dedupePeople(message.onlinePeople), snapshot.onlinePeople);
      return connectedSnapshot(snapshot, cursor, {
        onlinePeople: sameValues(nextPeople, snapshot.onlinePeople) ? snapshot.onlinePeople : nextPeople
      });
    }
    case "heartbeat":
      return connectedSnapshot(snapshot, cursor);
    case "error":
      return { ...snapshot, connectionState: "offline", cursor, error: `${message.code}:${message.message}` };
  }
}

export function createSubscribeMessage(workspaceId: string, cursor?: string): PortalLiveClientMessage {
  return {
    cursor,
    sentAt: new Date().toISOString(),
    type: "subscribe",
    version: PORTAL_LIVE_PROTOCOL_VERSION,
    workspaceId
  };
}

function dedupeActivities(activities: LiveSnapshot["activities"]) {
  const seen = new Set<string>();
  const uniqueActivities = activities.filter((activity) => {
    if (seen.has(activity.id)) {
      return false;
    }
    seen.add(activity.id);
    return true;
  }).sort((left, right) => activityTime(right) - activityTime(left));

  return retainCommunityActivities(uniqueActivities, 80, 30);
}

function retainCommunityActivities(
  activities: LiveSnapshot["activities"],
  limit: number,
  communityReserve: number
) {
  if (activities.length <= limit) {
    return activities;
  }

  const reservedIds = new Set(activities
    .filter((activity) => portalLiveActivityChannel(activity) === "community")
    .slice(0, Math.min(limit, communityReserve))
    .map((activity) => activity.id));
  const selectedIds = new Set(reservedIds);

  for (const activity of activities) {
    if (selectedIds.size >= limit) {
      break;
    }
    selectedIds.add(activity.id);
  }

  return activities.filter((activity) => selectedIds.has(activity.id));
}

function activityTime(activity: LiveSnapshot["activities"][number]) {
  const time = Date.parse(activity.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function dedupePeople(people: LiveSnapshot["onlinePeople"]) {
  const seen = new Set<string>();
  return people.filter((person) => {
    if (seen.has(person.id)) {
      return false;
    }
    seen.add(person.id);
    return true;
  });
}

function connectedSnapshot(
  snapshot: LiveSnapshot,
  cursor: string | undefined,
  updates: Partial<Pick<LiveSnapshot, "activities" | "onlinePeople">> = {}
): LiveSnapshot {
  const activities = updates.activities ?? snapshot.activities;
  const onlinePeople = updates.onlinePeople ?? snapshot.onlinePeople;
  if (
    activities === snapshot.activities
    && onlinePeople === snapshot.onlinePeople
    && snapshot.connectionState === "connected"
    && snapshot.cursor === cursor
    && snapshot.error === undefined
  ) {
    return snapshot;
  }

  return {
    ...snapshot,
    activities,
    connectionState: "connected",
    cursor,
    error: undefined,
    onlinePeople
  };
}

function preserveActivityAvatar(
  activity: LiveSnapshot["activities"][number],
  previousActivities: LiveSnapshot["activities"]
) {
  if (usableAvatarUrl(activity.actorAvatarUrl)) {
    return activity;
  }

  const previous = previousActivities.find((candidate) => (
    candidate.id === activity.id
    || Boolean(activity.actorUserId && candidate.actorUserId === activity.actorUserId)
  ));
  if (usableAvatarUrl(previous?.actorAvatarUrl)) {
    return { ...activity, actorAvatarUrl: previous?.actorAvatarUrl };
  }

  if (activity.actorAvatarUrl) {
    const { actorAvatarUrl: _discardedAvatarUrl, ...withoutBrokenAvatar } = activity;
    return withoutBrokenAvatar;
  }
  return activity;
}

function preservePeopleAvatars(
  people: LiveSnapshot["onlinePeople"],
  previousPeople: LiveSnapshot["onlinePeople"]
) {
  const previousById = new Map(previousPeople.map((person) => [person.id, person]));
  return people.map((person) => {
    if (usableAvatarUrl(person.avatarUrl)) {
      return person;
    }
    const previousAvatarUrl = previousById.get(person.id)?.avatarUrl;
    return usableAvatarUrl(previousAvatarUrl) ? { ...person, avatarUrl: previousAvatarUrl } : person;
  });
}

function usableAvatarUrl(value: string | undefined) {
  const url = value?.trim() ?? "";
  return Boolean(url) && !(url.startsWith("data:") && url.length === 2_048);
}

function sameValues(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
