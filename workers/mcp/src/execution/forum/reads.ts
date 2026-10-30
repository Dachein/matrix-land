import { readString } from "../../http.ts";
import { HttpError } from "../../types.ts";
import { boundedLimit, escapeLike, splitList } from "../values.ts";

export async function searchForumTopics(db: D1Database, args: Record<string, unknown>) {
  const limit = boundedLimit(args.limit);
  const query = readString(args.q).trim();
  const categorySlug = readString(args.categorySlug).trim();
  const filters: string[] = ["forum_topics.status = 'open'"];
  const binds: unknown[] = [];

  if (query) {
    filters.push("(lower(forum_topics.title) LIKE ? ESCAPE '\\' OR lower(forum_topics.excerpt) LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLike(query.toLowerCase())}%`;
    binds.push(pattern, pattern);
  }

  if (categorySlug) {
    filters.push("forum_categories.slug = ?");
    binds.push(categorySlug);
  }

  const updatedAfter = readString(args.updatedAfter).trim();
  if (updatedAfter) {
    const timestamp = Date.parse(updatedAfter);
    if (!Number.isFinite(timestamp)) throw new HttpError(400, "invalid_forum_updated_after");
    filters.push("forum_topics.last_active_at > ?");
    binds.push(new Date(timestamp).toISOString());
  }

  const rows = await db
    .prepare(
      `
      SELECT
        forum_topics.id,
        forum_topics.title,
        forum_topics.excerpt,
        forum_topics.topic_type AS topicType,
        forum_topics.source,
        forum_topics.status,
        forum_topics.reply_count AS replyCount,
        forum_topics.view_count AS viewCount,
        forum_topics.last_active_at AS lastActiveAt,
        forum_topics.created_at AS createdAt,
        forum_categories.name AS category,
        forum_categories.slug AS categorySlug,
        users.name AS author,
        users.email AS authorEmail,
        COALESCE(group_concat(DISTINCT forum_topic_tags.tag), '') AS tags
      FROM forum_topics
      JOIN forum_categories ON forum_categories.id = forum_topics.category_id
      JOIN users ON users.id = forum_topics.author_user_id
      LEFT JOIN forum_topic_tags ON forum_topic_tags.topic_id = forum_topics.id
      WHERE ${filters.join(" AND ")}
      GROUP BY forum_topics.id
      ORDER BY forum_topics.last_active_at DESC
      LIMIT ?
      `
    )
    .bind(...binds, limit)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({ ...row, tags: splitList(row.tags) }));
}

export async function getForumTopic(db: D1Database, topicId: string) {
  const topic = await db
    .prepare(
      `
      SELECT
        forum_topics.id,
        forum_topics.title,
        forum_topics.excerpt,
        forum_topics.topic_type AS topicType,
        forum_topics.source,
        forum_topics.status,
        forum_topics.reply_count AS replyCount,
        forum_topics.view_count AS viewCount,
        forum_topics.last_active_at AS lastActiveAt,
        forum_topics.created_at AS createdAt,
        forum_categories.name AS category,
        forum_categories.slug AS categorySlug,
        users.name AS author,
        users.email AS authorEmail,
        COALESCE(group_concat(DISTINCT forum_topic_tags.tag), '') AS tags
      FROM forum_topics
      JOIN forum_categories ON forum_categories.id = forum_topics.category_id
      JOIN users ON users.id = forum_topics.author_user_id
      LEFT JOIN forum_topic_tags ON forum_topic_tags.topic_id = forum_topics.id
      WHERE forum_topics.id = ? AND forum_topics.status = 'open'
      GROUP BY forum_topics.id
      LIMIT 1
      `
    )
    .bind(topicId)
    .first<Record<string, unknown>>();

  if (!topic) {
    throw new HttpError(404, "forum_topic_not_found");
  }

  const posts = await db
    .prepare(
      `
      SELECT
        forum_posts.id,
        forum_posts.parent_post_id AS parentPostId,
        forum_posts.body_markdown AS bodyMarkdown,
        forum_posts.source AS source,
        forum_posts.created_at AS createdAt,
        forum_posts.updated_at AS updatedAt,
        users.name AS author,
        users.email AS authorEmail
      FROM forum_posts
      JOIN users ON users.id = forum_posts.author_user_id
      WHERE forum_posts.topic_id = ?
      ORDER BY forum_posts.created_at ASC
      LIMIT 80
      `
    )
    .bind(topicId)
    .all<Record<string, unknown>>();

  const attachments = await db
    .prepare(
      `
      SELECT
        id,
        post_id AS postId,
        storage_provider AS storageProvider,
        storage_key AS storageKey,
        public_url AS publicUrl,
        mime_type AS mimeType,
        file_name AS fileName,
        file_size AS fileSize,
        display_order AS displayOrder,
        created_at AS createdAt
      FROM forum_attachments
      WHERE topic_id = ?
      ORDER BY display_order ASC, created_at ASC
      LIMIT 80
      `
    )
    .bind(topicId)
    .all<Record<string, unknown>>();

  return {
    ...topic,
    tags: splitList(topic.tags),
    posts: posts.results ?? [],
    attachments: attachments.results ?? []
  };
}

export async function getForumPost(db: D1Database, topicId: string, postId: string) {
  return await db
    .prepare(
      `
      SELECT
        forum_posts.id,
        forum_posts.parent_post_id AS parentPostId,
        forum_posts.body_markdown AS bodyMarkdown,
        forum_posts.source AS source,
        forum_posts.created_at AS createdAt,
        forum_posts.updated_at AS updatedAt,
        users.name AS author,
        users.email AS authorEmail
      FROM forum_posts
      JOIN users ON users.id = forum_posts.author_user_id
      WHERE forum_posts.topic_id = ? AND forum_posts.id = ?
      LIMIT 1
      `
    )
    .bind(topicId, postId)
    .first<Record<string, unknown>>();
}
