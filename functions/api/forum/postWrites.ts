import type { ForumAttachmentRecord, ForumContentPluginRecord, ForumLinkEmbedRecord } from "./types.ts";
import {
  notificationInsertStatement,
  notificationWriteWithId
} from "../notifications/writes.ts";

type ForumMentionTarget = {
  userId: string;
  text: string;
};

export function appendForumTopicTagInserts(statements: D1PreparedStatement[], db: D1Database, topicId: string, tags: string[]) {
  tags.forEach((tag) => {
    statements.push(db.prepare("INSERT OR IGNORE INTO forum_topic_tags (topic_id, tag) VALUES (?, ?)").bind(topicId, tag));
  });
}

export function appendForumAttachmentInserts(
  statements: D1PreparedStatement[],
  db: D1Database,
  options: {
    attachments: ForumAttachmentRecord[];
    displayOrderOffset?: number;
    ownerUserId: string;
    postId: string;
    topicId: string;
  }
) {
  options.attachments.forEach((attachment, index) => {
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .bind(
          crypto.randomUUID(),
          options.topicId,
          options.postId,
          options.ownerUserId,
          attachment.storageProvider,
          attachment.storageKey,
          attachment.publicUrl,
          attachment.mimeType,
          attachment.fileName,
          attachment.fileSize,
          (options.displayOrderOffset ?? 0) + index + 1
        )
    );
  });
}

export function appendForumLinkEmbedInserts(
  statements: D1PreparedStatement[],
  db: D1Database,
  options: {
    embeds: ForumLinkEmbedRecord[];
    postId: string;
    topicId: string;
  }
) {
  options.embeds.forEach((embed) => {
    statements.push(
      db
        .prepare(
          `
          INSERT INTO forum_link_embeds (
            id,
            topic_id,
            post_id,
            url,
            provider,
            title,
            description,
            preview_image_url,
            embed_type
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .bind(
          crypto.randomUUID(),
          options.topicId,
          options.postId,
          embed.url,
          embed.provider,
          embed.title,
          embed.description,
          embed.previewImageUrl ?? null,
          embed.embedType
        )
    );
  });
}

export function appendForumContentPluginInserts(
  statements: D1PreparedStatement[],
  db: D1Database,
  options: {
    plugins: ForumContentPluginRecord[];
    postId: string;
    topicId: string;
  }
) {
  options.plugins.forEach((plugin) => {
    statements.push(
      db
        .prepare(
          `
          INSERT INTO forum_content_plugins (
            id,
            topic_id,
            post_id,
            plugin_type,
            target_type,
            target_id,
            config_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          `
        )
        .bind(
          crypto.randomUUID(),
          options.topicId,
          options.postId,
          plugin.pluginType,
          plugin.targetType,
          plugin.targetId,
          JSON.stringify({
            actionLabel: plugin.actionLabel,
            category: plugin.category,
            description: plugin.description,
            iconUrl: plugin.iconUrl,
            installs: plugin.installs,
            owner: plugin.owner,
            title: plugin.title
          })
        )
    );
  });
}

export function appendForumMentionInserts(
  statements: D1PreparedStatement[],
  db: D1Database,
  options: {
    actorUserId: string;
    actorName?: string;
    defaultLocale?: "zh-CN" | "en";
    notificationActorUserId?: string | null;
    mentions: ForumMentionTarget[];
    notificationUserIds?: string[];
    notifyMentionedUsers?: boolean;
    postId: string;
    topicTitle?: string;
    topicId: string;
  }
) {
  const notificationIds: string[] = [];
  const notificationUserIds = new Set(
    options.notificationUserIds
      ?? (options.notifyMentionedUsers ? options.mentions.map((mention) => mention.userId) : [])
  );

  options.mentions.forEach((mention) => {
    statements.push(
      db
        .prepare(
          `
          INSERT INTO forum_mentions (id, topic_id, post_id, mentioned_user_id, mention_text, created_by_user_id)
          VALUES (?, ?, ?, ?, ?, ?)
          `
        )
        .bind(crypto.randomUUID(), options.topicId, options.postId, mention.userId, mention.text, options.actorUserId)
    );

    if (notificationUserIds.has(mention.userId) && mention.userId !== options.actorUserId) {
      const notification = notificationWriteWithId({
        actorUserId: options.notificationActorUserId === null
          ? undefined
          : options.notificationActorUserId ?? options.actorUserId,
        dedupeKey: `forum.mention:${options.postId}:${mention.userId}`,
        entityId: options.postId,
        entityType: "forum_post",
        href: `#/posts/${encodeURIComponent(options.topicId)}`,
        metadata: {
          mentionText: mention.text,
          postId: options.postId,
          topicId: options.topicId,
          topicTitle: options.topicTitle
        },
        notificationType: "forum.mention",
        parentId: options.topicId,
        parentType: "forum_topic",
        recipientUserId: mention.userId,
        summary: options.defaultLocale === "en"
          ? `${options.actorName || "Someone"} mentioned you${options.topicTitle ? ` in "${options.topicTitle}"` : ""}`
          : `${options.actorName || "有人"} 提到了你${options.topicTitle ? `：《${options.topicTitle}》` : ""}`
      });
      notificationIds.push(notification.id);
      statements.push(
        notificationInsertStatement(db, notification)
      );
    }
  });

  return notificationIds;
}

export async function readForumAttachmentStorageKeys(db: D1Database, topicId: string, postId: string) {
  const attachmentRows = await db
    .prepare(
      `
      SELECT storage_key AS storageKey
      FROM forum_attachments
      WHERE topic_id = ?
        AND post_id = ?
      `
    )
    .bind(topicId, postId)
    .all<{ storageKey: string }>();

  return (attachmentRows.results ?? []).map((row) => row.storageKey).filter(Boolean);
}

export function forumPostSideEffectDeleteStatements(db: D1Database, topicId: string, postId: string) {
  return [
    db.prepare("DELETE FROM notifications WHERE entity_type = 'forum_post' AND entity_id = ?").bind(postId),
    db.prepare("DELETE FROM forum_notifications WHERE topic_id = ? AND post_id = ?").bind(topicId, postId),
    db.prepare("DELETE FROM forum_mentions WHERE topic_id = ? AND post_id = ?").bind(topicId, postId),
    db.prepare("DELETE FROM forum_link_embeds WHERE topic_id = ? AND post_id = ?").bind(topicId, postId),
    db.prepare("DELETE FROM forum_content_plugins WHERE topic_id = ? AND post_id = ?").bind(topicId, postId),
    db.prepare("DELETE FROM forum_attachments WHERE topic_id = ? AND post_id = ?").bind(topicId, postId),
    db.prepare("DELETE FROM forum_post_likes WHERE post_id = ?").bind(postId)
  ];
}
