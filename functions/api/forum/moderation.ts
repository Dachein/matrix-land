import type { CurrentUser, ForumContext, ForumDeps, ForumEnv } from "./types.ts";

export function canModerateForumUser(currentUser: CurrentUser) {
  return currentUser.roles?.includes("community_admin") === true;
}

export async function requireCommunityAdminUser<TEnv extends ForumEnv>(
  db: D1Database,
  currentUser: CurrentUser,
  deps: ForumDeps<TEnv>
) {
  if (canModerateForumUser(currentUser)) return;

  // The catalog/session role projection can lag immediately after an assigned
  // role update. Authorize mutations from the canonical assignment table.
  const assignedRole = await db
    .prepare("SELECT 1 AS assigned FROM user_roles WHERE user_id = ? AND role = 'community_admin' LIMIT 1")
    .bind(currentUser.id)
    .first<{ assigned?: number }>();

  if (!assignedRole?.assigned) {
    throw deps.httpError(403, "community_admin_required");
  }
}

export function createForumModerationApi<TEnv extends ForumEnv>(deps: ForumDeps<TEnv>) {
  return {
    async setForumTopicPinned(context: ForumContext<TEnv>, rawTopicId: string, pinned: boolean) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      await requireCommunityAdminUser(db, currentUser, deps);
      const topicId = decodeURIComponent(rawTopicId);
      const topic = await db
        .prepare("SELECT id FROM forum_topics WHERE id = ? AND status != 'archived' LIMIT 1")
        .bind(topicId)
        .first<{ id: string }>();

      if (!topic) throw deps.httpError(404, "forum_topic_not_found");

      await (pinned
        ? db.prepare("UPDATE forum_topics SET is_pinned = 1, pinned_by_user_id = ?, pinned_at = CURRENT_TIMESTAMP WHERE id = ?").bind(currentUser.id, topicId)
        : db.prepare("UPDATE forum_topics SET is_pinned = 0, pinned_by_user_id = NULL, pinned_at = NULL WHERE id = ?").bind(topicId)
      ).run();

      await deps.audit(db, "user", currentUser.id, pinned ? "pinned forum topic" : "unpinned forum topic", "forum_topic", topicId, {});
      return { id: topicId, pinned };
    },

    async setForumReplyPinned(context: ForumContext<TEnv>, rawTopicId: string, rawPostId: string, pinned: boolean) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      await requireCommunityAdminUser(db, currentUser, deps);
      const topicId = decodeURIComponent(rawTopicId);
      const postId = decodeURIComponent(rawPostId);
      const reply = await db
        .prepare(
          `
          SELECT
            forum_posts.id,
            (
              SELECT root_posts.id
              FROM forum_posts AS root_posts
              WHERE root_posts.topic_id = forum_posts.topic_id
                AND root_posts.parent_post_id IS NULL
              ORDER BY root_posts.created_at ASC
              LIMIT 1
            ) AS rootPostId
          FROM forum_posts
          JOIN forum_topics ON forum_topics.id = forum_posts.topic_id
          WHERE forum_posts.id = ?
            AND forum_posts.topic_id = ?
            AND forum_topics.status != 'archived'
          LIMIT 1
          `
        )
        .bind(postId, topicId)
        .first<{ id: string; rootPostId: string }>();

      if (!reply) throw deps.httpError(404, "forum_reply_not_found");
      if (reply.id === reply.rootPostId) throw deps.httpError(400, "cannot_pin_topic_post_as_reply");

      await (pinned
        ? db.prepare("UPDATE forum_posts SET is_pinned = 1, pinned_by_user_id = ?, pinned_at = CURRENT_TIMESTAMP WHERE id = ? AND topic_id = ?").bind(currentUser.id, postId, topicId)
        : db.prepare("UPDATE forum_posts SET is_pinned = 0, pinned_by_user_id = NULL, pinned_at = NULL WHERE id = ? AND topic_id = ?").bind(postId, topicId)
      ).run();

      await deps.audit(db, "user", currentUser.id, pinned ? "pinned forum reply" : "unpinned forum reply", "forum_post", postId, { topicId });
      return { id: postId, topicId, pinned };
    }
  };
}
