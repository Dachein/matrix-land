import { platformBrandFromEnv } from "../../../src/shared/platformBrand.ts";
import { normalizeForumReaction } from "./normalizers.ts";
import type { ForumContext, ForumDeps, ForumEnv } from "./types.ts";
import { readNumber } from "./utils.ts";

export function createForumReactionApi<TEnv extends ForumEnv>(deps: ForumDeps<TEnv>) {
  return {
    async setForumTopicLike(context: ForumContext<TEnv>, rawTopicId: string, liked: boolean) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const topicId = decodeURIComponent(rawTopicId);
      const body = liked ? await deps.readBody<{ reaction?: string }>(context.request) : {};
      const reaction = normalizeForumReaction(body.reaction);
      const rootPost = await db
        .prepare(
          `
          SELECT
            forum_posts.id AS postId,
            forum_topics.title AS topicTitle,
            forum_topics.author_user_id AS authorUserId
          FROM forum_topics
          JOIN forum_posts ON forum_posts.topic_id = forum_topics.id
          WHERE forum_topics.id = ?
            AND forum_topics.status != 'archived'
            AND forum_posts.parent_post_id IS NULL
          ORDER BY forum_posts.created_at ASC
          LIMIT 1
          `
        )
        .bind(topicId)
        .first<{ postId: string; topicTitle: string; authorUserId?: string }>();

      if (!rootPost?.postId) {
        throw deps.httpError(404, "forum_topic_not_found");
      }

      if (liked) {
        await db
          .prepare(
            `
            INSERT INTO forum_post_likes (post_id, user_id, reaction)
            VALUES (?, ?, ?)
            ON CONFLICT(post_id, user_id) DO UPDATE SET
              reaction = excluded.reaction,
              created_at = CURRENT_TIMESTAMP
            `
          )
          .bind(rootPost.postId, currentUser.id, reaction)
          .run();
      } else {
        await db
          .prepare("DELETE FROM forum_post_likes WHERE post_id = ? AND user_id = ?")
          .bind(rootPost.postId, currentUser.id)
          .run();
      }

      const count = await db
        .prepare("SELECT COUNT(*) AS likes FROM forum_post_likes WHERE post_id = ?")
        .bind(rootPost.postId)
        .first<{ likes: number }>();
      const reactionSummary = await forumReactionSummary(db, rootPost.postId);

      await deps.audit(db, "user", currentUser.id, liked ? "reacted to forum topic" : "removed forum topic reaction", "forum_topic", topicId, {
        postId: rootPost.postId,
        reaction: liked ? reaction : undefined
      });

      // Community Spark belongs to the topic author. Refresh that user's
      // Journey projection when a new reaction is recorded so the threshold
      // badge does not wait for the author to revisit the Journey page.
      if (liked && rootPost.authorUserId) {
        await deps.refreshUserJourneyState(db, rootPost.authorUserId, context);
      }

      if (liked) {
        const teamId = await deps.currentUserTeamId(db, currentUser, context.env);
        await deps.emitActivityEvent(db, {
          scenario: "community",
          actionType: "forum.reaction.created",
          actor: currentUser,
          target: {
            type: "forum_post",
            id: rootPost.postId,
            title: rootPost.topicTitle
          },
          parent: {
            type: "forum_topic",
            id: topicId,
            title: rootPost.topicTitle
          },
          summary: platformBrandFromEnv(context.env).defaultLocale === "en" ? `${currentUser.name} reacted to "${rootPost.topicTitle}"` : `${currentUser.name} 回应了帖子《${rootPost.topicTitle}》`,
          href: `#/community/${topicId}`,
          teamId,
          metadata: {
            postId: rootPost.postId,
            reaction
          }
        }, context);
      }

      return {
        topicId,
        postId: rootPost.postId,
        liked,
        reaction: liked ? reaction : undefined,
        likes: readNumber(count?.likes),
        reactions: reactionSummary
      };
    },

    async setForumReplyLike(context: ForumContext<TEnv>, rawTopicId: string, rawPostId: string, liked: boolean) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const topicId = decodeURIComponent(rawTopicId);
      const postId = decodeURIComponent(rawPostId);
      const body = liked ? await deps.readBody<{ reaction?: string }>(context.request) : {};
      const reaction = normalizeForumReaction(body.reaction);
      const reply = await db
        .prepare(
          `
          SELECT
            forum_posts.id AS postId,
            forum_posts.topic_id AS topicId,
            forum_topics.title AS topicTitle,
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
        .first<{ postId: string; topicId: string; topicTitle: string; rootPostId: string }>();

      if (!reply?.postId) {
        throw deps.httpError(404, "forum_reply_not_found");
      }

      if (reply.rootPostId === reply.postId) {
        throw deps.httpError(400, "use_topic_like_endpoint");
      }

      if (liked) {
        await db
          .prepare(
            `
            INSERT INTO forum_post_likes (post_id, user_id, reaction)
            VALUES (?, ?, ?)
            ON CONFLICT(post_id, user_id) DO UPDATE SET
              reaction = excluded.reaction,
              created_at = CURRENT_TIMESTAMP
            `
          )
          .bind(reply.postId, currentUser.id, reaction)
          .run();
      } else {
        await db
          .prepare("DELETE FROM forum_post_likes WHERE post_id = ? AND user_id = ?")
          .bind(reply.postId, currentUser.id)
          .run();
      }

      const count = await db
        .prepare("SELECT COUNT(*) AS likes FROM forum_post_likes WHERE post_id = ?")
        .bind(reply.postId)
        .first<{ likes: number }>();
      const reactionSummary = await forumReactionSummary(db, reply.postId);

      await deps.audit(db, "user", currentUser.id, liked ? "reacted to forum reply" : "removed forum reply reaction", "forum_post", reply.postId, {
        topicId,
        reaction: liked ? reaction : undefined
      });

      if (liked) {
        const teamId = await deps.currentUserTeamId(db, currentUser, context.env);
        await deps.emitActivityEvent(db, {
          scenario: "community",
          actionType: "forum.reaction.created",
          actor: currentUser,
          target: {
            type: "forum_post",
            id: reply.postId,
            title: reply.topicTitle
          },
          parent: {
            type: "forum_topic",
            id: topicId,
            title: reply.topicTitle
          },
          summary: platformBrandFromEnv(context.env).defaultLocale === "en" ? `${currentUser.name} reacted to "${reply.topicTitle}"` : `${currentUser.name} 回应了帖子《${reply.topicTitle}》`,
          href: `#/community/${topicId}`,
          teamId,
          metadata: {
            postId: reply.postId,
            reaction
          }
        }, context);
      }

      return {
        topicId,
        postId: reply.postId,
        liked,
        reaction: liked ? reaction : undefined,
        likes: readNumber(count?.likes),
        reactions: reactionSummary
      };
    }
  };
}

export async function forumReactionSummary(db: D1Database, postId: string) {
  const rows = await db
    .prepare(
      `
      SELECT COALESCE(reaction, 'thumbsup') AS reaction, COUNT(*) AS count
      FROM forum_post_likes
      WHERE post_id = ?
      GROUP BY COALESCE(reaction, 'thumbsup')
      ORDER BY count DESC, reaction ASC
      `
    )
    .bind(postId)
    .all<{ reaction: string; count: number }>();

  return (rows.results ?? []).map((row) => ({
    reaction: normalizeForumReaction(row.reaction),
    count: readNumber(row.count)
  }));
}
