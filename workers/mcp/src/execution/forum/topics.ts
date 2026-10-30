import { emitMcpForumCommunityActivity, scheduleMcpForumNotifications } from "../../activity.ts";
import { readNumber, readString } from "../../http.ts";
import { MAX_FORUM_ATTACHMENTS, MAX_FORUM_BODY_CHARS } from "../../toolDefinitions/shared.ts";
import { type Env, HttpError, type Principal } from "../../types.ts";
import { requireArg, requireText } from "../values.ts";
import { resolveMcpForumAttachments, sanitizeMcpForumAttachmentRequests } from "./attachments.ts";
import {
  defaultForumCategoryIdForTopicType,
  forumCategoryIdForSlug,
  normalizeForumCategorySlug,
  normalizeTopicType
} from "./categories.ts";
import { ensureForumUser, mcpForumActorName } from "./identity.ts";
import { appendMcpMentionStatements, parseMcpMentionPrefixes, resolveMcpMentionTargets } from "./mentions.ts";
import { getForumTopic } from "./reads.ts";

// Own forum topic mutations, optimistic edit checks and author-scoped idempotency.
export async function createForumTopic(
  env: Env,
  args: Record<string, unknown>,
  principal: Principal,
  executionContext?: Pick<ExecutionContext, "waitUntil">
) {
  const db = env.DB;
  const title = requireText(args.title, "missing_forum_topic_title", 140);
  const bodyMarkdown = (readString(args.bodyMarkdown) || readString(args.body)).trim().slice(0, MAX_FORUM_BODY_CHARS);

  if (!bodyMarkdown) {
    throw new HttpError(400, "missing_forum_topic_body");
  }

  const topicType = normalizeTopicType(args.topicType);
  const categorySlug = normalizeForumCategorySlug(args.categorySlug);
  const categoryId = categorySlug
    ? await forumCategoryIdForSlug(db, categorySlug)
    : await defaultForumCategoryIdForTopicType(db, topicType);
  const author = await ensureForumUser(env, principal);
  const tags = sanitizeTags(args.tags);
  const contentHash = await forumTopicContentHash({
    bodyMarkdown,
    categoryId,
    tags: [...tags].sort(),
    title,
    topicType
  });
  const suppliedIdempotencyKey = forumTopicIdempotencyKey(args.idempotencyKey);
  const idempotencyKey = suppliedIdempotencyKey ?? `auto:${Math.floor(Date.now() / 300_000)}:${contentHash}`;
  const existingByKey = await findForumTopicByIdempotencyKey(db, author.id, idempotencyKey);

  if (existingByKey) {
    if (existingByKey.contentHash !== contentHash) {
      throw new HttpError(409, "forum_idempotency_key_conflict");
    }
    if (existingByKey.status !== "open") {
      throw new HttpError(409, "forum_idempotency_topic_not_open");
    }
    return await getForumTopic(db, existingByKey.id);
  }

  const recentDuplicate = await findRecentForumTopicByContentHash(db, author.id, contentHash);
  if (recentDuplicate) {
    return await getForumTopic(db, recentDuplicate.id);
  }

  const topicId = crypto.randomUUID();
  const postId = crypto.randomUUID();
  const mentions = await resolveMcpMentionTargets(db, parseMcpMentionPrefixes(`${title} ${bodyMarkdown}`));
  const statements = [
    db
      .prepare(
        `
        INSERT INTO forum_topics (
          id,
          category_id,
          author_user_id,
          title,
          topic_type,
          bu_team_id,
          excerpt,
          source,
          idempotency_key,
          content_hash,
          status,
          last_active_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'mcp', ?, ?, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `
      )
      .bind(topicId, categoryId, author.id, title, topicType, author.teamId, excerpt(bodyMarkdown), idempotencyKey, contentHash),
    db
      .prepare(
        `
        INSERT INTO forum_posts (id, topic_id, author_user_id, body_markdown, source)
        VALUES (?, ?, ?, ?, 'mcp')
        `
      )
      .bind(postId, topicId, author.id, bodyMarkdown),
    db
      .prepare(
        `
        INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
        VALUES (?, 'user', ?, 'created forum topic from MCP', 'forum_topic', ?, ?)
        `
      )
      .bind(crypto.randomUUID(), author.id, topicId, JSON.stringify({
        agentType: principal.agentType,
        connectionId: principal.connectionId,
        contentHash,
        idempotencyKey,
        suppliedIdempotencyKey: Boolean(suppliedIdempotencyKey)
      }))
  ];

  tags.forEach((tag) => {
    statements.push(db.prepare("INSERT OR IGNORE INTO forum_topic_tags (topic_id, tag) VALUES (?, ?)").bind(topicId, tag));
  });
  const notificationIds = appendMcpMentionStatements(statements, db, {
    actorUserId: author.id,
    actorName: readString(principal.name) || "Agent",
    mentions,
    postId,
    topicId,
    topicTitle: title
  });

  try {
    await db.batch(statements);
  } catch (error) {
    const concurrentDuplicate = await findForumTopicByIdempotencyKey(db, author.id, idempotencyKey);
    if (concurrentDuplicate?.contentHash === contentHash && concurrentDuplicate.status === "open") {
      return await getForumTopic(db, concurrentDuplicate.id);
    }
    throw error;
  }
  scheduleMcpForumNotifications(env, notificationIds, executionContext);
  await emitMcpForumCommunityActivity(env, {
    actionType: "forum.topic.created",
    actorName: mcpForumActorName(principal),
    actorTeam: principal.team,
    actorUserId: author.id,
    href: `#/community/${topicId}`,
    metadata: {
      categoryId,
      mentionedUserIds: mentions.map((mention) => mention.userId).filter((userId) => userId !== author.id),
      postId,
      tags
    },
    sourceEventId: `forum.topic.created:${topicId}`,
    summary: `${mcpForumActorName(principal)} 发布了帖子《${title}》`,
    targetId: topicId,
    targetTitle: title,
    targetType: "forum_topic",
    teamId: author.teamId
  }, executionContext);
  return await getForumTopic(db, topicId);
}

export async function updateForumTopic(env: Env, args: Record<string, unknown>, principal: Principal) {
  const db = env.DB;
  const topicId = requireArg(args.topicId, "missing_topic_id");
  const title = requireText(args.title, "missing_forum_topic_title", 140);
  const bodyMarkdown = (readString(args.bodyMarkdown) || readString(args.body)).trim().slice(0, MAX_FORUM_BODY_CHARS);
  const requestedAttachments = sanitizeMcpForumAttachmentRequests(args.attachments);

  if (!bodyMarkdown) {
    throw new HttpError(400, "missing_forum_topic_body");
  }

  const author = await ensureForumUser(env, principal);
  const topic = await db
    .prepare(
      `
      SELECT
        forum_topics.author_user_id AS authorUserId,
        root_posts.id AS rootPostId
      FROM forum_topics
      JOIN forum_posts AS root_posts ON root_posts.id = (
        SELECT root_post_lookup.id
        FROM forum_posts AS root_post_lookup
        WHERE root_post_lookup.topic_id = forum_topics.id
          AND root_post_lookup.parent_post_id IS NULL
        ORDER BY root_post_lookup.created_at ASC
        LIMIT 1
      )
      WHERE forum_topics.id = ?
        AND forum_topics.status = 'open'
      LIMIT 1
      `
    )
    .bind(topicId)
    .first<{ authorUserId: string; rootPostId: string }>();

  if (!topic) {
    throw new HttpError(404, "forum_topic_not_found");
  }

  if (topic.authorUserId !== author.id) {
    throw new HttpError(403, "forum_topic_update_forbidden");
  }

  const attachmentRows = await db
    .prepare(
      `
      SELECT
        id,
        storage_key AS storageKey,
        display_order AS displayOrder
      FROM forum_attachments
      WHERE topic_id = ?
        AND post_id = ?
      ORDER BY display_order ASC, created_at ASC
      `
    )
    .bind(topicId, topic.rootPostId)
    .all<{ id: string; storageKey: string; displayOrder: number }>();
  const existingAttachments = attachmentRows.results ?? [];
  const existingAttachmentIds = new Set(existingAttachments.map((attachment) => attachment.id));
  const existingAttachmentByToken = new Map(
    existingAttachments.flatMap((attachment) => [
      [attachment.id, attachment] as const,
      [attachment.storageKey, attachment] as const
    ])
  );
  let retainedAttachmentIds = new Set(existingAttachmentIds);

  if (args.retainedAttachmentIds !== undefined) {
    if (!Array.isArray(args.retainedAttachmentIds)) {
      throw new HttpError(400, "invalid_forum_topic_attachment_selection");
    }
    const requestedTokens = args.retainedAttachmentIds
      .map((value) => readString(value).trim())
      .filter(Boolean);
    if (requestedTokens.some((token) => !existingAttachmentByToken.has(token))) {
      throw new HttpError(400, "invalid_forum_topic_attachment_selection");
    }
    retainedAttachmentIds = new Set(
      requestedTokens
        .map((token) => existingAttachmentByToken.get(token)?.id)
        .filter((id): id is string => Boolean(id))
    );
  }

  const requestedStorageKeys = new Set(requestedAttachments.map((attachment) => attachment.storageKey));
  const existingStorageKeys = new Set(existingAttachments.map((attachment) => attachment.storageKey));
  const retainedAttachments = existingAttachments.filter(
    (attachment) => retainedAttachmentIds.has(attachment.id) || requestedStorageKeys.has(attachment.storageKey)
  );
  const retainedIds = new Set(retainedAttachments.map((attachment) => attachment.id));
  const removedAttachments = existingAttachments.filter((attachment) => !retainedIds.has(attachment.id));
  const attachmentsToAppend = requestedAttachments.filter((attachment) => !existingStorageKeys.has(attachment.storageKey));

  if (retainedAttachments.length + attachmentsToAppend.length > MAX_FORUM_ATTACHMENTS) {
    throw new HttpError(400, "too_many_forum_attachments");
  }

  const newAttachments = await resolveMcpForumAttachments(env, attachmentsToAppend, author.id);
  const displayOrderOffset = retainedAttachments.reduce(
    (maximum, attachment) => Math.max(maximum, readNumber(attachment.displayOrder)),
    0
  );

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `
        UPDATE forum_topics
        SET title = ?, excerpt = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'open'
        `
      )
      .bind(title, excerpt(bodyMarkdown), topicId),
    db
      .prepare(
        `
        UPDATE forum_posts
        SET body_markdown = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND topic_id = ?
          AND EXISTS (
            SELECT 1 FROM forum_topics
            WHERE forum_topics.id = ? AND forum_topics.status = 'open'
          )
        `
      )
      .bind(bodyMarkdown, topic.rootPostId, topicId, topicId),
    db
      .prepare(
        `
        INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
        SELECT ?, 'user', ?, 'updated forum topic from MCP', 'forum_topic', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM forum_topics
          WHERE forum_topics.id = ? AND forum_topics.status = 'open'
        )
        `
      )
      .bind(crypto.randomUUID(), author.id, topicId, JSON.stringify({
        addedAttachmentCount: newAttachments.length,
        agentType: principal.agentType,
        connectionId: principal.connectionId,
        postId: topic.rootPostId,
        removedAttachmentCount: removedAttachments.length
      }), topicId)
  ];

  removedAttachments.forEach((attachment) => {
    statements.push(
      db
        .prepare("DELETE FROM forum_attachments WHERE id = ? AND topic_id = ? AND post_id = ?")
        .bind(attachment.id, topicId, topic.rootPostId)
    );
  });

  newAttachments.forEach((attachment, index) => {
    statements.push(
      db
        .prepare(
          `
          INSERT INTO forum_attachments (
            id,
            topic_id,
            post_id,
            owner_user_id,
            storage_provider,
            storage_key,
            public_url,
            mime_type,
            file_name,
            file_size,
            display_order
          )
          VALUES (?, ?, ?, ?, 'r2', ?, ?, ?, ?, ?, ?)
          `
        )
        .bind(
          crypto.randomUUID(),
          topicId,
          topic.rootPostId,
          author.id,
          attachment.storageKey,
          attachment.publicUrl,
          attachment.mimeType,
          attachment.fileName,
          attachment.fileSize,
          displayOrderOffset + index + 1
        )
    );
  });

  await db.batch(statements);

  if (env.FORUM_MEDIA && removedAttachments.length > 0) {
    await Promise.all(
      removedAttachments.map((attachment) => env.FORUM_MEDIA?.delete(attachment.storageKey).catch(() => undefined))
    );
  }

  return await getForumTopic(db, topicId);
}

async function findForumTopicByIdempotencyKey(db: D1Database, authorUserId: string, idempotencyKey: string) {
  return await db
    .prepare(
      `
      SELECT id, content_hash AS contentHash, status
      FROM forum_topics
      WHERE author_user_id = ?
        AND idempotency_key = ?
      LIMIT 1
      `
    )
    .bind(authorUserId, idempotencyKey)
    .first<{ id: string; contentHash: string; status: string }>();
}

async function findRecentForumTopicByContentHash(db: D1Database, authorUserId: string, contentHash: string) {
  return await db
    .prepare(
      `
      SELECT id
      FROM forum_topics
      WHERE author_user_id = ?
        AND content_hash = ?
        AND source = 'mcp'
        AND status = 'open'
        AND created_at >= datetime('now', '-5 minutes')
      ORDER BY created_at DESC
      LIMIT 1
      `
    )
    .bind(authorUserId, contentHash)
    .first<{ id: string }>();
}

async function forumTopicContentHash(value: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function forumTopicIdempotencyKey(value: unknown) {
  const key = readString(value).trim();
  if (!key) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    throw new HttpError(400, "invalid_forum_idempotency_key");
  }
  return `client:${key}`;
}

export function sanitizeTags(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => /^[a-z0-9][a-z0-9._-]{0,31}$/.test(tag))
    )
  ).slice(0, 8);
}

export function excerpt(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}
