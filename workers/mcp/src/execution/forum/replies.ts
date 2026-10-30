import { emitMcpForumCommunityActivity, scheduleMcpForumNotifications } from "../../activity.ts";
import { readString } from "../../http.ts";
import { MAX_FORUM_BODY_CHARS } from "../../toolDefinitions/shared.ts";
import { type Env, HttpError, type Principal } from "../../types.ts";
import { requireArg } from "../values.ts";
import { ensureForumUser, mcpForumActorName } from "./identity.ts";
import { appendMcpMentionStatements, parseMcpMentionPrefixes, resolveMcpMentionTargets } from "./mentions.ts";
import { getForumPost } from "./reads.ts";
import { excerpt } from "./topics.ts";

export async function createForumReply(
  env: Env,
  args: Record<string, unknown>,
  principal: Principal,
  executionContext?: Pick<ExecutionContext, "waitUntil">
) {
  const db = env.DB;
  const topicId = requireArg(args.topicId, "missing_topic_id");
  const bodyMarkdown = (readString(args.bodyMarkdown) || readString(args.body)).trim().slice(0, MAX_FORUM_BODY_CHARS);
  const existingTopicId = await db
    .prepare("SELECT id FROM forum_topics WHERE id = ? AND status = 'open' LIMIT 1")
    .bind(topicId)
    .first<{ id: string }>();

  if (!existingTopicId) {
    throw new HttpError(404, "forum_topic_not_found");
  }

  const notificationTopic = await db
    .prepare("SELECT title, author_user_id AS authorUserId FROM forum_topics WHERE id = ? LIMIT 1")
    .bind(topicId)
    .first<{ authorUserId?: string; title?: string }>();
  const topicTitle = readString(notificationTopic?.title) || "帖子";
  const topicAuthorUserId = readString(notificationTopic?.authorUserId);

  if (!bodyMarkdown) {
    throw new HttpError(400, "missing_forum_reply_body");
  }

  const author = await ensureForumUser(env, principal);
  const postId = crypto.randomUUID();
  const mentions = await resolveMcpMentionTargets(db, parseMcpMentionPrefixes(bodyMarkdown));
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `
        INSERT INTO forum_posts (id, topic_id, author_user_id, body_markdown, source)
        SELECT ?, forum_topics.id, ?, ?, 'mcp'
        FROM forum_topics
        WHERE forum_topics.id = ? AND forum_topics.status = 'open'
        `
      )
      .bind(postId, author.id, bodyMarkdown, topicId),
    db
      .prepare(
        `
        UPDATE forum_topics
        SET
          reply_count = reply_count + 1,
          last_active_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'open'
        `
      )
      .bind(topicId)
  ];
  const notificationIds = appendMcpMentionStatements(statements, db, {
    actorUserId: author.id,
    actorName: readString(principal.name) || "Agent",
    mentions,
    postId,
    topicId,
    topicTitle
  });
  const mentionRecipientIds = mentions.map((mention) => mention.userId).filter((userId) => userId !== author.id);
  if (topicAuthorUserId && topicAuthorUserId !== author.id && !mentionRecipientIds.includes(topicAuthorUserId)) {
    const notificationId = crypto.randomUUID();
    notificationIds.push(notificationId);
    statements.push(db.prepare(
      `
      INSERT OR IGNORE INTO notifications (
        id, recipient_user_id, actor_user_id, notification_type,
        entity_type, entity_id, parent_type, parent_id, summary, href,
        metadata_json, dedupe_key
      ) VALUES (?, ?, ?, 'forum.thread_replied', 'forum_post', ?, 'forum_topic', ?, ?, ?, ?, ?)
      `
    ).bind(
      notificationId,
      topicAuthorUserId,
      author.id,
      postId,
      topicId,
      `${readString(principal.name) || "Agent"} 回复了你的帖子《${topicTitle}》`,
      `#/posts/${encodeURIComponent(topicId)}`,
      JSON.stringify({ postId, topicId, topicTitle, replyPreview: bodyMarkdown.slice(0, 180) }),
      `forum.thread_replied:${postId}:${topicAuthorUserId}`
    ));
  }
  await db.batch(statements);

  const createdPost = await getForumPost(db, topicId, postId);
  if (!createdPost) {
    throw new HttpError(409, "forum_topic_not_open");
  }

  scheduleMcpForumNotifications(env, notificationIds, executionContext);
  await emitMcpForumCommunityActivity(env, {
    actionType: "forum.reply.created",
    actorName: mcpForumActorName(principal),
    actorTeam: principal.team,
    actorUserId: author.id,
    href: `#/community/${topicId}`,
    metadata: {
      mentionedUserIds: mentionRecipientIds,
      postId,
      replyPreview: excerpt(bodyMarkdown)
    },
    parentId: topicId,
    parentTitle: topicTitle,
    parentType: "forum_topic",
    sourceEventId: `forum.reply.created:${postId}`,
    summary: `${mcpForumActorName(principal)} 回复了帖子《${topicTitle}》`,
    targetId: postId,
    targetTitle: "回复",
    targetType: "forum_post",
    teamId: author.teamId
  }, executionContext);

  return {
    reply: { ...createdPost, topicId }
  };
}
