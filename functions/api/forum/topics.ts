import { defaultForumCategoryIdForTopicType, forumCategoryIdForSlug, normalizeForumCategorySlug } from "./categories.ts";
import { readCatalogDiscussion } from "../catalog/forumProjection.ts";
import { normalizeForumAnonymousPersona } from "../../../src/portal/forum/forumAnonymousIdentity.ts";
import { schedulePortalLiveEvent } from "../../../src/shared/portalLivePublisher.ts";
import { previewForumLink as previewForumLinkHandler, sanitizeForumLinkEmbeds } from "./linkPreview.ts";
import { MAX_FORUM_ATTACHMENTS, sanitizeForumAttachments } from "./media.ts";
import { canModerateForumUser } from "./moderation.ts";
import { mentionRecipientUserIds, parseMentionPrefixes, resolveMentionTargets } from "./mentions.ts";
import { normalizeTopicType, sanitizeForumContentPlugins } from "./normalizers.ts";
import {
  appendForumContentPluginInserts,
  appendForumAttachmentInserts,
  appendForumLinkEmbedInserts,
  appendForumMentionInserts,
  appendForumTopicTagInserts
} from "./postWrites.ts";
import type { ForumAttachmentInput, ForumContext, ForumDeps, ForumEnv } from "./types.ts";
import { MAX_FORUM_BODY_CHARS, readNumber, readString } from "./utils.ts";
import { publicForumActor } from "./anonymousIdentity.ts";

export function createForumTopicApi<TEnv extends ForumEnv>(deps: ForumDeps<TEnv>) {
  return {
    async previewForumLink(context: ForumContext<TEnv>) {
      return previewForumLinkHandler(context, deps);
    },

    async createForumTopic(context: ForumContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<{
        title?: string;
        body?: string;
        categoryId?: string;
        categorySlug?: string;
        topicType?: string;
        tags?: string[];
        attachments?: ForumAttachmentInput[];
        contentPlugins?: unknown[];
        links?: string[];
        linkUrls?: string[];
        linkedSkillId?: string;
        linkedAppId?: string;
        linkedMcpServerId?: string;
        anonymous?: boolean;
        anonymousPersona?: string;
      }>(context.request);
      const title = deps.requireText(body.title, "missing_forum_topic_title", 140);
      const attachments = sanitizeForumAttachments(body.attachments, deps);
      const linkEmbeds = await sanitizeForumLinkEmbeds(body.links ?? body.linkUrls, deps);
      const contentPlugins = sanitizeForumContentPlugins(body.contentPlugins);
      const bodyMarkdown = readString(body.body).trim().slice(0, MAX_FORUM_BODY_CHARS);
      const anonymous = body.anonymous === true;
      const anonymousPersona = anonymous ? normalizeForumAnonymousPersona(body.anonymousPersona) : undefined;

      if (anonymous && !anonymousPersona) {
        throw deps.httpError(400, "invalid_forum_anonymous_persona");
      }
      const publicActor = publicForumActor(currentUser, anonymousPersona);

      if (bodyMarkdown.length === 0 && attachments.length === 0 && linkEmbeds.length === 0 && contentPlugins.length === 0) {
        throw deps.httpError(400, "missing_forum_topic_body");
      }

      const topicType = normalizeTopicType(body.topicType);
      let categoryId = body.categoryId;

      if (!categoryId) {
        categoryId = await forumCategoryIdForSlug(db, normalizeForumCategorySlug(body.categorySlug));
      }

      if (!categoryId) {
        categoryId = await defaultForumCategoryIdForTopicType(db, topicType, deps);
      }

      const topicId = crypto.randomUUID();
      const postId = crypto.randomUUID();
      const tags = deps.sanitizeTags(body.tags);
      const mentions = await resolveMentionTargets(db, parseMentionPrefixes(`${title} ${bodyMarkdown}`), context.env);
      const userTeam = await db.prepare("SELECT team_id AS teamId FROM users WHERE id = ? LIMIT 1").bind(currentUser.id).first<{ teamId: string }>();
      const linkedSkillId = readString(body.linkedSkillId).trim() || undefined;
      const linkedAppId = readString(body.linkedAppId).trim() || undefined;
      const linkedMcpServerId = readString(body.linkedMcpServerId).trim() || undefined;
      const statements: D1PreparedStatement[] = [
        db
          .prepare(
            `
            INSERT INTO forum_topics (
              id,
              category_id,
              author_user_id,
              is_anonymous,
              anonymous_persona,
              title,
              topic_type,
              bu_team_id,
              linked_skill_id,
              linked_app_id,
              linked_mcp_server_id,
              excerpt
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .bind(
            topicId,
            categoryId,
            currentUser.id,
            anonymous ? 1 : 0,
            anonymousPersona ?? null,
            title,
            topicType ?? "",
            userTeam?.teamId ?? context.env.DEFAULT_TEAM_ID ?? null,
            linkedSkillId ?? null,
            linkedAppId ?? null,
            linkedMcpServerId ?? null,
            deps.excerpt(bodyMarkdown)
          ),
        db
          .prepare(
            `
            INSERT INTO forum_posts (id, topic_id, author_user_id, is_anonymous, anonymous_persona, body_markdown)
            VALUES (?, ?, ?, ?, ?, ?)
            `
          )
          .bind(postId, topicId, currentUser.id, anonymous ? 1 : 0, anonymousPersona ?? null, bodyMarkdown)
      ];

      appendForumTopicTagInserts(statements, db, topicId, tags);
      appendForumAttachmentInserts(statements, db, {
        attachments,
        ownerUserId: currentUser.id,
        postId,
        topicId
      });
      appendForumLinkEmbedInserts(statements, db, {
        embeds: linkEmbeds,
        postId,
        topicId
      });
      appendForumContentPluginInserts(statements, db, {
        plugins: contentPlugins,
        postId,
        topicId
      });
      const notificationIds = appendForumMentionInserts(statements, db, {
        actorUserId: currentUser.id,
        actorName: publicActor.name,
        notificationActorUserId: anonymous ? null : currentUser.id,
        mentions,
        notifyMentionedUsers: true,
        postId,
        topicTitle: title,
        topicId
      });

      await db.batch(statements);
      await deps.refreshUserJourneyState(db, currentUser.id, context);
      notificationIds.forEach((id) => {
        schedulePortalLiveEvent(context, { notificationId: id });
      });
      await deps.audit(db, "user", currentUser.id, "created forum topic", "forum_topic", topicId, {
        categoryId,
        tags,
        attachmentCount: attachments.length,
        linkCount: linkEmbeds.length,
        pluginCount: contentPlugins.length,
        linkedAppId,
        linkedMcpServerId,
        linkedSkillId,
        anonymous,
        anonymousPersona
      });
      await deps.emitActivityEvent(db, {
        scenario: "community",
        actionType: "forum.topic.created",
        actor: publicActor,
        target: {
          type: "forum_topic",
          id: topicId,
          title
        },
        summary: `${publicActor.name} 发布了帖子《${title}》`,
        href: `#/community/${topicId}`,
        teamId: userTeam?.teamId ?? context.env.DEFAULT_TEAM_ID,
        metadata: {
          categoryId,
          tags,
          attachmentCount: attachments.length,
          linkCount: linkEmbeds.length,
          pluginCount: contentPlugins.length,
          linkedAppId,
          linkedMcpServerId,
          linkedSkillId,
          anonymous,
          anonymousPersona,
          mentionedUserIds: mentionRecipientUserIds(mentions, currentUser.id)
        },
        sourceEventId: `forum.topic.created:${topicId}`
      }, context);

      const discussion = await readCatalogDiscussion(db, currentUser, await deps.userProfileColumns(db), topicId);

      if (!discussion) {
        throw deps.httpError(500, "forum_topic_projection_failed");
      }

      return { id: topicId, postId, discussion };
    },

    async updateForumTopic(context: ForumContext<TEnv>, rawTopicId: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const topicId = decodeURIComponent(rawTopicId);
      const body = await deps.readBody<{
        title?: string;
        body?: string;
        attachments?: ForumAttachmentInput[];
        retainedAttachmentIds?: unknown;
      }>(context.request);
      const title = deps.requireText(body.title, "missing_forum_topic_title", 140);
      const bodyMarkdown = readString(body.body).trim().slice(0, MAX_FORUM_BODY_CHARS);
      const newAttachments = sanitizeForumAttachments(body.attachments, deps);
      const topic = await db
        .prepare(
          `
          SELECT
            forum_topics.id,
            forum_topics.author_user_id AS authorUserId,
            forum_topics.is_anonymous AS anonymous,
            forum_topics.anonymous_persona AS anonymousPersona,
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
            AND forum_topics.status != 'archived'
          LIMIT 1
          `
        )
        .bind(topicId)
        .first<{ anonymous: number; anonymousPersona?: string; id: string; authorUserId: string; rootPostId: string }>();

      if (!topic) {
        throw deps.httpError(404, "forum_topic_not_found");
      }

      if (topic.authorUserId !== currentUser.id) {
        throw deps.httpError(403, "forum_topic_update_forbidden");
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

      if (body.retainedAttachmentIds !== undefined) {
        if (!Array.isArray(body.retainedAttachmentIds)) {
          throw deps.httpError(400, "invalid_forum_topic_attachment_selection");
        }

        const requestedTokens = body.retainedAttachmentIds
          .map((value) => readString(value))
          .filter(Boolean);

        if (requestedTokens.some((token) => !existingAttachmentByToken.has(token))) {
          throw deps.httpError(400, "invalid_forum_topic_attachment_selection");
        }

        retainedAttachmentIds = new Set(
          requestedTokens
            .map((token) => existingAttachmentByToken.get(token)?.id)
            .filter((id): id is string => Boolean(id))
        );
      }

      if (retainedAttachmentIds.size + newAttachments.length > MAX_FORUM_ATTACHMENTS) {
        throw deps.httpError(400, "too_many_forum_attachments");
      }

      if (bodyMarkdown.length === 0 && retainedAttachmentIds.size === 0 && newAttachments.length === 0) {
        throw deps.httpError(400, "missing_forum_topic_body");
      }

      const removedAttachments = existingAttachments.filter((attachment) => !retainedAttachmentIds.has(attachment.id));
      const retainedAttachments = existingAttachments.filter((attachment) => retainedAttachmentIds.has(attachment.id));
      const mentions = await resolveMentionTargets(db, parseMentionPrefixes(`${title} ${bodyMarkdown}`), context.env);
      const anonymous = topic.anonymous === 1;
      const anonymousPersona = anonymous ? normalizeForumAnonymousPersona(topic.anonymousPersona) : undefined;
      const publicActor = publicForumActor(currentUser, anonymousPersona);
      const previousMentions = await db
        .prepare("SELECT mentioned_user_id AS userId FROM forum_mentions WHERE topic_id = ? AND post_id = ?")
        .bind(topicId, topic.rootPostId)
        .all<{ userId: string }>();
      const statements: D1PreparedStatement[] = [
        db
          .prepare(
            `
            UPDATE forum_topics
            SET title = ?, excerpt = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `
          )
          .bind(title, deps.excerpt(bodyMarkdown), topicId),
        db
          .prepare(
            `
            UPDATE forum_posts
            SET body_markdown = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND topic_id = ?
            `
          )
          .bind(bodyMarkdown, topic.rootPostId, topicId),
        db.prepare("DELETE FROM forum_mentions WHERE topic_id = ? AND post_id = ?").bind(topicId, topic.rootPostId)
      ];

      removedAttachments.forEach((attachment) => {
        statements.push(
          db
            .prepare("DELETE FROM forum_attachments WHERE id = ? AND topic_id = ? AND post_id = ?")
            .bind(attachment.id, topicId, topic.rootPostId)
        );
      });
      appendForumAttachmentInserts(statements, db, {
        attachments: newAttachments,
        displayOrderOffset: retainedAttachments.reduce(
          (maximum, attachment) => Math.max(maximum, readNumber(attachment.displayOrder)),
          0
        ),
        ownerUserId: currentUser.id,
        postId: topic.rootPostId,
        topicId
      });

      const notificationIds = appendForumMentionInserts(statements, db, {
        actorUserId: currentUser.id,
        actorName: publicActor.name,
        notificationActorUserId: anonymous ? null : currentUser.id,
        mentions,
        notificationUserIds: mentionRecipientUserIds(
          mentions,
          currentUser.id,
          (previousMentions.results ?? []).map((mention) => mention.userId)
        ),
        postId: topic.rootPostId,
        topicTitle: title,
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

      await deps.audit(db, "user", currentUser.id, "updated forum topic", "forum_topic", topicId, {
        addedAttachmentCount: newAttachments.length,
        anonymous,
        anonymousPersona,
        postId: topic.rootPostId,
        removedAttachmentCount: removedAttachments.length
      });

      return { id: topicId, postId: topic.rootPostId, updated: true };
    },

    async deleteForumTopic(context: ForumContext<TEnv>, rawTopicId: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const topicId = decodeURIComponent(rawTopicId);
      const topic = await db
        .prepare(
          `
          SELECT id, author_user_id AS authorUserId
          FROM forum_topics
          WHERE id = ?
            AND status != 'archived'
          LIMIT 1
          `
        )
        .bind(topicId)
        .first<{ id: string; authorUserId: string }>();

      if (!topic) {
        throw deps.httpError(404, "forum_topic_not_found");
      }

      if (topic.authorUserId !== currentUser.id && !canModerateForumUser(currentUser)) {
        throw deps.httpError(403, "forum_topic_delete_forbidden");
      }

      const topicAuthors = await db
        .prepare("SELECT DISTINCT author_user_id AS authorUserId FROM forum_posts WHERE topic_id = ?")
        .bind(topicId)
        .all<{ authorUserId: string }>();

      await db
        .prepare(
          `
          UPDATE forum_topics
          SET status = 'archived', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `
        )
        .bind(topicId)
        .run();

      const affectedAuthorUserIds = Array.from(new Set(
        (topicAuthors.results ?? []).map((author) => author.authorUserId).filter(Boolean)
      ));
      for (const authorUserId of affectedAuthorUserIds) {
        await deps.refreshUserJourneyState(db, authorUserId, context);
      }

      await deps.audit(db, "user", currentUser.id, "deleted forum topic", "forum_topic", topicId, {});

      return { id: topicId, deleted: true };
    },

    async recordForumTopicView(context: ForumContext<TEnv>, rawTopicId: string) {
      const db = deps.requireDb(context.env.DB);
      await deps.resolveCurrentUser(context);
      const topicId = decodeURIComponent(rawTopicId);

      await db
        .prepare(
          `
          UPDATE forum_topics
          SET view_count = view_count + 1
          WHERE id = ?
            AND status != 'archived'
          `
        )
        .bind(topicId)
        .run();

      const topic = await db
        .prepare("SELECT view_count AS views FROM forum_topics WHERE id = ? AND status != 'archived' LIMIT 1")
        .bind(topicId)
        .first<{ views: number }>();

      if (!topic) {
        throw deps.httpError(404, "forum_topic_not_found");
      }

      return {
        topicId,
        views: readNumber(topic.views)
      };
    }
  };
}
