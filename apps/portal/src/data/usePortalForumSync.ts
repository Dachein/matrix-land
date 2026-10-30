import { useCallback, useEffect, useRef } from "react";
import type { ForumDiscussionQuery } from "../../../../src/shared/types";
import type { LiveActivityItem, LiveDataSource } from "../live/liveDataSource";
import { forumDiscussionQueryKey } from "./usePortalData";

const FORUM_AUTO_REFRESH_INTERVAL_MS = 60_000;
const FORUM_LIVE_REFRESH_DEBOUNCE_MS = 600;

export function usePortalForumSync({
  currentUserId,
  landing,
  liveDataSource,
  loadMoreDiscussions,
  refreshDiscussions
}: {
  currentUserId?: string;
  landing: boolean;
  liveDataSource?: LiveDataSource;
  loadMoreDiscussions: (query?: ForumDiscussionQuery) => Promise<boolean>;
  refreshDiscussions: (
    query?: ForumDiscussionQuery,
    options?: { stage?: boolean }
  ) => Promise<boolean>;
}) {
  const liveRefreshTimerRef = useRef<number | undefined>(undefined);
  const queryRef = useRef<ForumDiscussionQuery>({});
  const queryKeyRef = useRef(forumDiscussionQueryKey({}));
  const seenLiveActivityIdsRef = useRef(new Set<string>());

  const changeForumQuery = useCallback((query: ForumDiscussionQuery) => {
    const queryKey = forumDiscussionQueryKey(query);
    if (queryKeyRef.current === queryKey) {
      return;
    }

    queryRef.current = query;
    queryKeyRef.current = queryKey;
    void refreshDiscussions(query);
  }, [refreshDiscussions]);

  const loadMoreForumDiscussions = useCallback(() => {
    void loadMoreDiscussions(queryRef.current);
  }, [loadMoreDiscussions]);

  useEffect(() => {
    if (!landing || !currentUserId) {
      return undefined;
    }

    const refreshVisibleForum = () => {
      if (document.visibilityState !== "hidden") {
        void refreshDiscussions(queryRef.current, { stage: true });
      }
    };
    const interval = window.setInterval(refreshVisibleForum, FORUM_AUTO_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshVisibleForum);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisibleForum);
    };
  }, [currentUserId, landing, refreshDiscussions]);

  useEffect(() => {
    const forumActivities = liveDataSource?.getSnapshot().activities.filter(isForumLiveActivity) ?? [];
    const seenActivityIds = seenLiveActivityIdsRef.current;

    if (seenActivityIds.size === 0) {
      forumActivities.forEach((activity) => seenActivityIds.add(activity.id));
    }

    if (!liveDataSource?.subscribe) {
      return undefined;
    }

    return liveDataSource.subscribe((snapshot) => {
      let hasNewForumActivity = false;
      snapshot.activities.forEach((activity) => {
        if (!isForumLiveActivity(activity) || seenActivityIds.has(activity.id)) {
          return;
        }
        seenActivityIds.add(activity.id);
        hasNewForumActivity = true;
      });

      if (!hasNewForumActivity || liveRefreshTimerRef.current !== undefined) {
        return;
      }

      liveRefreshTimerRef.current = window.setTimeout(() => {
        liveRefreshTimerRef.current = undefined;
        void refreshDiscussions(queryRef.current, { stage: true });
      }, FORUM_LIVE_REFRESH_DEBOUNCE_MS);
    });
  }, [liveDataSource, refreshDiscussions]);

  useEffect(() => () => {
    if (liveRefreshTimerRef.current !== undefined) {
      window.clearTimeout(liveRefreshTimerRef.current);
    }
  }, []);

  return { changeForumQuery, loadMoreForumDiscussions };
}

function isForumLiveActivity(activity: LiveActivityItem) {
  return activity.eventType?.startsWith("forum.") === true
    || activity.entityType === "forum_topic"
    || activity.entityType === "forum_post";
}
