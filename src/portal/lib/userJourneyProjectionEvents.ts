import type { PortalJourneyLevelKey } from "../../shared/types";

export const USER_JOURNEY_PROJECTION_UPDATED_EVENT = "workspace:user-journey-projection-updated";

export type UserJourneyProjectionUpdate = {
  id: string;
  journeyBadgeCount?: number;
  journeyCommunityContributionPoints: number;
  journeyLevelKey: PortalJourneyLevelKey;
  journeyTotalPoints: number;
};

const latestUpdates = new Map<string, UserJourneyProjectionUpdate>();

export function publishUserJourneyProjectionUpdate(update: UserJourneyProjectionUpdate) {
  latestUpdates.set(update.id, update);
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(USER_JOURNEY_PROJECTION_UPDATED_EVENT, { detail: update }));
}

export function withLatestUserJourneyProjection<T extends { id: string }>(user: T): T {
  const update = latestUpdates.get(user.id);
  return update ? { ...user, ...update } : user;
}

export function subscribeToUserJourneyProjectionUpdates(
  listener: (update: UserJourneyProjectionUpdate) => void
) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleUpdate = (event: Event) => {
    const update = (event as CustomEvent<unknown>).detail;
    if (isUserJourneyProjectionUpdate(update)) {
      listener(update);
    }
  };
  window.addEventListener(USER_JOURNEY_PROJECTION_UPDATED_EVENT, handleUpdate);
  return () => window.removeEventListener(USER_JOURNEY_PROJECTION_UPDATED_EVENT, handleUpdate);
}

function isUserJourneyProjectionUpdate(value: unknown): value is UserJourneyProjectionUpdate {
  if (!value || typeof value !== "object") {
    return false;
  }

  const update = value as Partial<UserJourneyProjectionUpdate>;
  return typeof update.id === "string"
    && update.id.length > 0
    && typeof update.journeyCommunityContributionPoints === "number"
    && typeof update.journeyTotalPoints === "number"
    && (update.journeyLevelKey === "newcomer"
      || update.journeyLevelKey === "explorer"
      || update.journeyLevelKey === "contributor"
      || update.journeyLevelKey === "builder"
      || update.journeyLevelKey === "master");
}
