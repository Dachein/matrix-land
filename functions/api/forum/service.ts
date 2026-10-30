import { createForumMediaApi, validForumStorageKey } from "./media.ts";
import { createForumContributorAwardApi } from "./contributorAwards.ts";
import { createForumModerationApi } from "./moderation.ts";
import { createForumReactionApi } from "./reactions.ts";
import { createForumReplyApi } from "./replies.ts";
import { createForumTopicApi } from "./topics.ts";
import type { ForumContext, ForumDeps, ForumEnv } from "./types.ts";
import {
  readCatalogDiscussion,
  readCatalogDiscussionPage,
  validForumDiscussionCursor
} from "../catalog/forumProjection.ts";

export { validForumStorageKey };

export function createForumApi<TEnv extends ForumEnv>(deps: ForumDeps<TEnv>) {
  const mediaApi = createForumMediaApi(deps);

  return {
    async getForumTopic(context: ForumContext<TEnv>, rawTopicId: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const topicId = decodeURIComponent(rawTopicId);
      const discussion = await readCatalogDiscussion(db, currentUser, await deps.userProfileColumns(db), topicId);

      if (!discussion) {
        throw deps.httpError(404, "forum_topic_not_found");
      }

      return { discussion };
    },

    async listForumTopics(context: ForumContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const searchParams = new URL(context.request.url).searchParams;
      const cursor = searchParams.get("cursor")?.trim() || undefined;
      if (cursor && !validForumDiscussionCursor(cursor)) {
        throw deps.httpError(400, "invalid_forum_cursor");
      }

      return readCatalogDiscussionPage(db, currentUser, await deps.userProfileColumns(db), {
        category: searchParams.get("category")?.trim() || undefined,
        cursor,
        limit: Number(searchParams.get("limit") || undefined),
        owner: searchParams.get("owner") === "mine" ? "mine" : "all",
        query: searchParams.get("q")?.trim() || undefined
      });
    },

    async uploadForumMedia(context: ForumContext<TEnv>) {
      return mediaApi.uploadForumMedia(context);
    },

    async getForumMedia(context: ForumContext<TEnv>, rawKey: string) {
      return mediaApi.getForumMedia(context, rawKey);
    },

    async deleteForumMediaDraft(context: ForumContext<TEnv>, rawKey: string) {
      return mediaApi.deleteForumMediaDraft(context, rawKey);
    },

    ...createForumTopicApi(deps),
    ...createForumContributorAwardApi(deps),
    ...createForumModerationApi(deps),
    ...createForumReactionApi(deps),
    ...createForumReplyApi(deps)
  };
}
