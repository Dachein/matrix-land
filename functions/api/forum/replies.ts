import { platformBrandFromEnv } from "../../../src/shared/platformBrand.ts";
import { MAX_FORUM_ATTACHMENTS, sanitizeForumAttachments } from "./media.ts";
import { schedulePortalLiveEvent } from "../../../src/shared/portalLivePublisher.ts";
import { canModerateForumUser } from "./moderation.ts";
import { mentionRecipientUserIds, parseMentionPrefixes, resolveMentionTargets } from "./mentions.ts";
import {
  appendForumAttachmentInserts,
  appendForumMentionInserts,
  forumPostSideEffectDeleteStatements,
  readForumAttachmentStorageKeys
} from "./postWrites.ts";
import type { ForumAttachmentInput, ForumContext, ForumDeps, ForumEnv } from "./types.ts";
import { MAX_FORUM_BODY_CHARS, readString } from "./utils.ts";
import {
  notificationInsertStatement,
  notificationWriteWithId
} from "../notifications/writes.ts";
import { normalizeForumAnonymousPersona } from "../../../src/portal/forum/forumAnonymousIdentity.ts";
import { existingForumAnonymousPersona, publicForumActor } from "./anonymousIdentity.ts";

export function createForumReplyApi<TEnv extends ForumEnv>(deps: ForumDeps<TEnv>) {
  return {
    async createForumReply(context: ForumContext<TEnv>, topicId: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<{
        anonymous?: boolean;
        anonymousPersona?: string;
        attachments?: ForumAttachmentInput[];
        body?: string;
        parentPostId?: string;
      }>(context.request);
      const bodyMarkdown = readString(body.body).trim().slice(0, MAX_FORUM_BODY_CHARS);
      const attachments = sanitizeForumAttachments(body.attachments, deps);
      const topic = await db.prepare("SELECT id, title FROM forum_topics WHERE id = ? AND status != 'archived' LIMIT 1").bind(topicId).first<{ id: string; title: string }>();

      if (!topic) {
        throw deps.httpError(404, "forum_topic_not_found");
      }

      const topicAuthor = await db
        .prepare("SELECT author_user_id AS authorUserId FROM forum_topics WHERE id = ? LIMIT 1")
        .bind(topicId)
        .first<{ authorUserId?: string }>();

      if (bodyMarkdown.length === 0 && attachments.length === 0) {
        throw deps.httpError(400, "missing_forum_reply_body");
      }

      const anonymous = body.anonymous === true;
      const anonymousPersona = anonymous
        ? await existingForumAnonymousPersona(db, topicId, currentUser.id)
          ?? normalizeForumAnonymousPersona(body.anonymousPersona)
        : undefined;

      if (anonymous && !anonymousPersona) {
        throw deps.httpError(400, "invalid_forum_anonymous_persona");
      }

      const publicActor = publicForumActor(currentUser, anonymousPersona);

      const postId = crypto.randomUUID();
      const mentions = await resolveMentionTargets(db, parseMentionPrefixes(bodyMarkdown), context.env);
      const statements: D1PreparedStatement[] = [
        db
          .prepare(
            `
            INSERT INTO forum_posts (
              id,
              topic_id,
              author_user_id,
              is_anonymous,
              anonymous_persona,
              body_markdown,
              parent_post_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `
          )
          .bind(
            postId,
            topicId,
            currentUser.id,
            anonymous ? 1 : 0,
            anonymousPersona ?? null,
            bodyMarkdown,
            body.parentPostId ?? null
          ),
        db
          .prepare(
            `
            UPDATE forum_topics
            SET
              reply_count = reply_count + 1,
              last_active_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `
          )
          .bind(topicId)
      ];

      appendForumAttachmentInserts(statements, db, {
        attachments,
        ownerUserId: currentUser.id,
        postId,
        topicId
      });
      const notificationIds = appendForumMentionInserts(statements, db, {
        defaultLocale: platformBrandFromEnv(context.env).defaultLocale,
        actorUserId: currentUser.id,
        actorName: publicActor.name,
        notificationActorUserId: anonymous ? null : currentUser.id,
        mentions,
        notifyMentionedUsers: true,
        postId,
        topicTitle: topic.title,
        topicId
      });
      const mentionRecipientIds = mentionRecipientUserIds(mentions, currentUser.id);
      if (topicAuthor?.authorUserId && topicAuthor.authorUserId !== currentUser.id && !mentionRecipientIds.includes(topicAuthor.authorUserId)) {
        const notification = notificationWriteWithId({
          actorUserId: anonymous ? undefined : currentUser.id,
          dedupeKey: `forum.thread_replied:${postId}:${topicAuthor.authorUserId}`,
          entityId: postId,
          entityType: "forum_post",
          href: `#/posts/${encodeURIComponent(topicId)}`,
          metadata: {
            postId,
            replyPreview: deps.excerpt(bodyMarkdown),
            topicId,
            topicTitle: topic.title
          },
          notificationType: "forum.thread_replied",
          parentId: topicId,
          parentType: "forum_topic",
          recipientUserId: topicAuthor.authorUserId,
          summary: platformBrandFromEnv(context.env).defaultLocale === "en" ? `${publicActor.name} replied to your post "${topic.title}"` : `${publicActor.name} 回复了你的帖子《${topic.title}》`
        });
        notificationIds.push(notification.id);
        statements.push(notificationInsertStatement(db, notification));
      }

      await db.batch(statements);
      await deps.refreshUserJourneyState(db, currentUser.id, context);
      if (topicAuthor?.authorUserId && topicAuthor.authorUserId !== currentUser.id) {
        // A reply can push the topic over the Community Spark threshold, so
        // refresh the topic author's projection as part of the same mutation.
        await deps.refreshUserJourneyState(db, topicAuthor.authorUserId, context);
      }
      notificationIds.forEach((id) => {
        schedulePortalLiveEvent(context, { notificationId: id });
      });
      await deps.audit(db, "user", currentUser.id, "replied to forum topic", "forum_topic", topicId, {
        postId,
        attachmentCount: attachments.length,
        anonymous,
        anonymousPersona
      });
      const teamId = await deps.currentUserTeamId(db, currentUser, context.env);
      await deps.emitActivityEvent(db, {
        scenario: "community",
        actionType: "forum.reply.created",
        actor: publicActor,
        target: {
          type: "forum_post",
          id: postId,
          title: platformBrandFromEnv(context.env).defaultLocale === "en" ? "Reply" : "回复"
        },
        parent: {
          type: "forum_topic",
          id: topicId,
          title: topic.title
        },
        summary: platformBrandFromEnv(context.env).defaultLocale === "en" ? `${publicActor.name} replied to "${topic.title}"` : `${publicActor.name} 回复了帖子《${topic.title}》`,
        href: `#/community/${topicId}`,
        teamId,
        metadata: {
          postId,
          attachmentCount: attachments.length,
          anonymous,
          anonymousPersona,
          replyPreview: deps.excerpt(bodyMarkdown),
          mentionedUserIds: mentionRecipientIds
        },
        sourceEventId: `forum.reply.created:${postId}`
      }, context);

      return { id: postId, topicId, anonymous, anonymousPersona };
    },

    async updateForumReply(context: ForumContext<TEnv>, topicId: string, postId: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<{
        attachments?: ForumAttachmentInput[];
        body?: string;
        retainedAttachmentIds?: unknown;
      }>(context.request);
      const bodyMarkdown = readString(body.body).trim().slice(0, MAX_FORUM_BODY_CHARS);
      const newAttachments = sanitizeForumAttachments(body.attachments, deps);
      const reply = await db
        .prepare(
          `
          SELECT
            forum_posts.id,
            forum_posts.topic_id AS topicId,
            forum_posts.author_user_id AS authorUserId,
            forum_posts.is_anonymous AS anonymous,
            forum_posts.anonymous_persona AS anonymousPersona,
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
        .first<{
          anonymous: number;
          anonymousPersona?: string;
          id: string;
          topicId: string;
          authorUserId: string;
          rootPostId: string;
          topicTitle: string;
        }>();

      if (!reply) {
        throw deps.httpError(404, "forum_reply_not_found");
      }

      if (reply.rootPostId === reply.id) {
        throw deps.httpError(400, "cannot_update_topic_post");
      }

      if (reply.authorUserId !== currentUser.id) {
        throw deps.httpError(403, "forum_reply_update_forbidden");
      }

      const attachmentRows = await db
        .prepare(
          `
          SELECT id, storage_key AS storageKey, display_order AS displayOrder
          FROM forum_attachments
          WHERE topic_id = ?
            AND post_id = ?
          ORDER BY display_order ASC, created_at ASC
          `
        )
        .bind(topicId, postId)
        .all<{ displayOrder: number; id: string; storageKey: string }>();
      const existingAttachments = attachmentRows.results ?? [];
      const existingAttachmentIds = new Set(existingAttachments.map((attachment) => attachment.id));
      const existingAttachmentByToken = new Map(
        existingAttachments.flatMap((attachment) => [
          [attachment.id, attachment] as const,
          [attachment.storageKey, attachment] as const
        ])
      );
      let retainedAttachmentIds = new Set(existingAttachmentIds);

      if (body.retainedAttachmentIds !== undefined) {
        if (!Array.isArray(body.retainedAttachmentIds)) {
          throw deps.httpError(400, "invalid_forum_reply_attachment_selection");
        }

        const requestedTokens = body.retainedAttachmentIds
          .map((value) => readString(value))
          .filter(Boolean);

        if (requestedTokens.some((token) => !existingAttachmentByToken.has(token))) {
          throw deps.httpError(400, "invalid_forum_reply_attachment_selection");
        }

        retainedAttachmentIds = new Set(
          requestedTokens
            .map((token) => existingAttachmentByToken.get(token)?.id)
            .filter((id): id is string => Boolean(id))
        );
      }

      const removedAttachments = existingAttachments.filter((attachment) => !retainedAttachmentIds.has(attachment.id));
      const retainedAttachments = existingAttachments.filter((attachment) => retainedAttachmentIds.has(attachment.id));

      if (retainedAttachmentIds.size + newAttachments.length > MAX_FORUM_ATTACHMENTS) {
        throw deps.httpError(400, "too_many_forum_attachments");
      }

      if (bodyMarkdown.length === 0 && retainedAttachmentIds.size === 0 && newAttachments.length === 0) {
        throw deps.httpError(400, "missing_forum_reply_body");
      }

      const mentions = await resolveMentionTargets(db, parseMentionPrefixes(bodyMarkdown), context.env);
      const anonymous = reply.anonymous === 1;
      const anonymousPersona = anonymous ? normalizeForumAnonymousPersona(reply.anonymousPersona) : undefined;
      const publicActor = publicForumActor(currentUser, anonymousPersona);
      const previousMentions = await db
        .prepare("SELECT mentioned_user_id AS userId FROM forum_mentions WHERE topic_id = ? AND post_id = ?")
        .bind(topicId, postId)
        .all<{ userId: string }>();
      const statements: D1PreparedStatement[] = [
        db
          .prepare(
            `
            UPDATE forum_posts
            SET body_markdown = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND topic_id = ?
            `
          )
          .bind(bodyMarkdown, postId, topicId),
        db.prepare("UPDATE forum_topics SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(topicId),
        db.prepare("DELETE FROM forum_mentions WHERE topic_id = ? AND post_id = ?").bind(topicId, postId)
      ];

      removedAttachments.forEach((attachment) => {
        statements.push(
          db
            .prepare("DELETE FROM forum_attachments WHERE id = ? AND topic_id = ? AND post_id = ?")
            .bind(attachment.id, topicId, postId)
        );
      });

      appendForumAttachmentInserts(statements, db, {
        attachments: newAttachments,
        displayOrderOffset: retainedAttachments.reduce(
          (maximum, attachment) => Math.max(maximum, Number(attachment.displayOrder) || 0),
          0
        ),
        ownerUserId: currentUser.id,
        postId,
        topicId
      });

      const notificationIds = appendForumMentionInserts(statements, db, {
        defaultLocale: platformBrandFromEnv(context.env).defaultLocale,
        actorUserId: currentUser.id,
        actorName: publicActor.name,
        notificationActorUserId: anonymous ? null : currentUser.id,
        mentions,
        notificationUserIds: mentionRecipientUserIds(
          mentions,
          currentUser.id,
          (previousMentions.results ?? []).map((mention) => mention.userId)
        ),
        postId,
        topicTitle: reply.topicTitle,
        topicId
      });

      await db.batch(statements);
      notificationIds.forEach((id) => {
        schedulePortalLiveEvent(context, { notificationId: id });
      });

      if (context.env.FORUM_MEDIA && removedAttachments.length > 0) {
        await Promise.all(
          removedAttachments.map((attachment) => context.env.FORUM_MEDIA?.delete(attachment.storageKey).catch(() => undefined))
        );
      }

      await deps.audit(db, "user", currentUser.id, "updated forum reply", "forum_topic", topicId, {
        addedAttachmentCount: newAttachments.length,
        anonymous,
        anonymousPersona,
        postId,
        removedAttachmentCount: removedAttachments.length
      });

      return { id: postId, topicId, updated: true };
    },

    async deleteForumReply(context: ForumContext<TEnv>, topicId: string, postId: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const reply = await db
        .prepare(
          `
          SELECT
            forum_posts.id,
            forum_posts.topic_id AS topicId,
            forum_posts.author_user_id AS authorUserId,
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
        .first<{ id: string; topicId: string; authorUserId: string; rootPostId: string }>();

      if (!reply) {
        throw deps.httpError(404, "forum_reply_not_found");
      }

      if (reply.rootPostId === reply.id) {
        throw deps.httpError(400, "cannot_delete_topic_post");
      }

      if (reply.authorUserId !== currentUser.id && !canModerateForumUser(currentUser)) {
        throw deps.httpError(403, "forum_reply_delete_forbidden");
      }

      const storageKeys = await readForumAttachmentStorageKeys(db, topicId, postId);

      await db.batch([
        ...forumPostSideEffectDeleteStatements(db, topicId, postId),
        db.prepare("UPDATE forum_posts SET parent_post_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE parent_post_id = ?").bind(postId),
        db.prepare("DELETE FROM forum_posts WHERE id = ? AND topic_id = ?").bind(postId, topicId),
        db
          .prepare(
            `
            UPDATE forum_topics
            SET
              reply_count = CASE WHEN reply_count > 0 THEN reply_count - 1 ELSE 0 END,
              last_active_at = COALESCE((SELECT MAX(created_at) FROM forum_posts WHERE topic_id = ?), created_at),
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `
          )
          .bind(topicId, topicId)
      ]);
      await deps.refreshUserJourneyState(db, reply.authorUserId, context);

      if (context.env.FORUM_MEDIA && storageKeys.length > 0) {
        await Promise.all(storageKeys.map((storageKey) => context.env.FORUM_MEDIA?.delete(storageKey).catch(() => undefined)));
      }

      await deps.audit(db, "user", currentUser.id, "deleted forum reply", "forum_topic", topicId, {
        postId,
        attachmentCount: storageKeys.length
      });

      return { id: postId, topicId, deleted: true };
    }
  };
}
