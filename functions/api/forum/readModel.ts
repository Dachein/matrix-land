import { portalJourneyLevels } from "../../../src/shared/journey.ts";
import type { Discussion, DiscussionAttachment, PortalJourneyLevelKey } from "../../../src/shared/types.ts";
import {
  forumAnonymousPersona,
  normalizeForumAnonymousPersona,
  type ForumDiscussion
} from "../../../src/portal/forum/forumAnonymousIdentity.ts";
import { normalizeEmbedType, normalizeForumReaction, normalizePluginTarget, normalizePluginType, normalizeTopicType } from "./normalizers.ts";
import { cacheableUserAvatarUrl } from "../users/avatar.ts";
import { cacheableCatalogImageUrl } from "../catalog/coverImage.ts";

export function buildForumDiscussions(
  topicRows: Record<string, unknown>[],
  attachmentRows: Record<string, unknown>[],
  linkRows: Record<string, unknown>[],
  pluginRows: Record<string, unknown>[],
  mentionRows: Record<string, unknown>[],
  replyRows: Record<string, unknown>[],
  contributorAwardRows: Record<string, unknown>[] = []
): ForumDiscussion[] {
  const attachmentsByTopic = groupRowsByTopic(attachmentRows);
  const linksByTopic = groupRowsByTopic(linkRows);
  const pluginsByTopic = groupRowsByTopic(pluginRows);
  const mentionsByTopic = groupRowsByTopic(mentionRows);
  const repliesByTopic = groupRowsByTopic(replyRows);
  const contributorAwardsByPost = new Map(
    contributorAwardRows.map((award) => [readString(award.postId), forumContributorAwardFromRow(award)])
  );

  return topicRows.map((row) => {
    const id = readString(row.id);
    const anonymous = readNumber(row.anonymous) === 1;
    const anonymousPersona = anonymous ? forumAnonymousPersona(row.anonymousPersona) : undefined;
    const tags = splitList(row.tags);
    const category = readString(row.category);
    const authorProfile = anonymous ? {} : discussionUserProfileFromRow(row, "author");
    const topicAttachments = attachmentsByTopic.get(id) ?? [];
    const topicReplies = repliesByTopic.get(id) ?? [];
    const replyIds = new Set(topicReplies.map((reply) => readString(reply.id)));

    return {
      id,
      rootPostId: readOptionalString(row.rootPostId),
      title: readString(row.title),
      authorId: anonymous ? undefined : readOptionalString(row.authorId),
      author: anonymousPersona?.name ?? readString(row.author),
      authorEmail: anonymous ? undefined : readOptionalString(row.authorEmail),
      authorAvatar: initials(anonymousPersona?.name ?? readString(row.author)),
      authorAvatarUrl: anonymousPersona?.avatarUrl ?? cacheableUserAvatarUrl(row.authorId, row.authorAvatarUrl),
      anonymous,
      anonymousPersona: anonymousPersona?.key,
      currentUserAnonymousPersona: normalizeForumAnonymousPersona(row.currentUserAnonymousPersona),
      ownedByCurrentUser: readNumber(row.ownedByCurrentUser) === 1,
      ...authorProfile,
      category,
      categorySlug: readOptionalString(row.categorySlug),
      topicType: normalizeTopicType(row.topicType),
      source: normalizeDiscussionSource(row.source),
      pinned: readNumber(row.pinned) === 1,
      bu: anonymous ? undefined : readOptionalString(row.bu),
      tag: tags[0] ?? category,
      tags,
      linkedSkill: readOptionalString(row.linkedSkill),
      linkedApp: readOptionalString(row.linkedApp),
      linkedMcp: readOptionalString(row.linkedMcp),
      createdAt: readOptionalString(row.createdAt),
      updatedAt: readOptionalString(row.updatedAt),
      replies: readNumber(row.replies),
      views: readNumber(row.views),
      likes: readNumber(row.likes),
      likedByCurrentUser: readNumber(row.likedByCurrentUser) === 1,
      currentUserReaction: readOptionalString(row.currentUserReaction),
      reactions: forumReactionsFromSummary(row.reactionSummary),
      lastActive: readString(row.lastActive),
      excerpt: readString(row.excerpt),
      body: readOptionalString(row.body),
      contributorAward: contributorAwardsByPost.get(readString(row.rootPostId)),
      attachments: topicAttachments
        .filter((attachment) => !replyIds.has(readString(attachment.postId)))
        .map(forumAttachmentFromRow),
      linkEmbeds: (linksByTopic.get(id) ?? []).map((link) => ({
        id: readString(link.id),
        url: readString(link.url),
        provider: readString(link.provider),
        title: readString(link.title),
        description: readString(link.description),
        embedType: normalizeEmbedType(link.embedType),
        previewImageUrl: readOptionalString(link.previewImageUrl)
      })),
      contentPlugins: (pluginsByTopic.get(id) ?? []).map((plugin) => {
        const config = readJsonObject(plugin.configJson);
        const targetType = normalizePluginTarget(plugin.targetType);
        const targetId = readString(plugin.targetId);
        const iconUrl = readOptionalString(plugin.iconUrl) ?? readOptionalString(config.iconUrl);
        return {
          id: readString(plugin.id),
          pluginType: normalizePluginType(plugin.pluginType),
          targetType,
          targetId,
          title: readOptionalString(config.title) ?? readString(plugin.title),
          description: readOptionalString(config.description) ?? readString(plugin.description),
          status: readOptionalString(plugin.status),
          actionLabel: readOptionalString(config.actionLabel),
          category: readOptionalString(config.category) ?? readOptionalString(plugin.category),
          iconUrl: cacheableCatalogImageUrl(targetType, targetId, iconUrl),
          installs: readNumber(config.installs) || readNumber(plugin.installs),
          owner: readOptionalString(config.owner) ?? readOptionalString(plugin.owner)
        };
      }),
      mentions: (mentionsByTopic.get(id) ?? []).map((mention) => ({
        id: readString(mention.id),
        userId: readString(mention.userId),
        postId: readOptionalString(mention.postId),
        name: readString(mention.name),
        email: readOptionalString(mention.email),
        emailPrefix: readString(mention.emailPrefix),
        avatarUrl: cacheableUserAvatarUrl(mention.userId, mention.avatarUrl),
        ...discussionUserProfileFromRow(mention),
        text: readString(mention.text)
      })),
      replyPosts: topicReplies.map((reply) => {
        const replyIsAnonymous = readNumber(reply.anonymous) === 1;
        const replyPersona = replyIsAnonymous ? forumAnonymousPersona(reply.anonymousPersona) : undefined;
        const replyAuthor = replyPersona?.name ?? readString(reply.author);

        return {
          id: readString(reply.id),
          authorId: replyIsAnonymous ? undefined : readOptionalString(reply.authorId),
          author: replyAuthor,
          authorEmail: replyIsAnonymous ? undefined : readOptionalString(reply.authorEmail),
          authorAvatar: initials(replyAuthor),
          authorAvatarUrl: replyPersona?.avatarUrl ?? cacheableUserAvatarUrl(reply.authorId, reply.authorAvatarUrl),
          anonymous: replyIsAnonymous,
          anonymousPersona: replyPersona?.key,
          ownedByCurrentUser: readNumber(reply.ownedByCurrentUser) === 1,
          ...(replyIsAnonymous ? {} : discussionUserProfileFromRow(reply, "author")),
          body: readString(reply.body),
          source: normalizeDiscussionSource(reply.source),
          pinned: readNumber(reply.pinned) === 1,
          contributorAward: contributorAwardsByPost.get(readString(reply.id)),
          createdAt: readString(reply.createdAt),
          updatedAt: readOptionalString(reply.updatedAt),
          attachments: topicAttachments
            .filter((attachment) => readString(attachment.postId) === readString(reply.id))
            .map(forumAttachmentFromRow),
          parentPostId: readOptionalString(reply.parentPostId),
          likes: readNumber(reply.likes),
          likedByCurrentUser: readNumber(reply.likedByCurrentUser) === 1,
          currentUserReaction: readOptionalString(reply.currentUserReaction),
          reactions: forumReactionsFromSummary(reply.reactionSummary)
        };
      })
    };
  });
}

function forumContributorAwardFromRow(award: Record<string, unknown>) {
  return {
    id: readString(award.id),
    awardedByName: readString(award.awardedByName),
    awardedByUserId: readString(award.awardedByUserId),
    createdAt: readString(award.createdAt),
    note: readString(award.note),
    points: readNumber(award.points)
  };
}

export function buildLegacyForumDiscussions(rows: Record<string, unknown>[]): Discussion[] {
  return rows.map((row) => ({
    ...row,
    ...discussionUserProfileFromRow(row, "author")
  })) as Discussion[];
}

function forumReactionsFromSummary(value: unknown) {
  return readString(value)
    .split(",")
    .map((entry) => {
      const [reaction, count] = entry.split(":");
      return {
        reaction: normalizeForumReaction(reaction),
        count: readNumber(count)
      };
    })
    .filter((reaction) => reaction.count > 0);
}

function forumAttachmentFromRow(attachment: Record<string, unknown>): DiscussionAttachment {
  const mimeType = readString(attachment.mimeType);
  const fileName = readString(attachment.fileName);

  return {
    id: readString(attachment.id),
    type: mimeType.startsWith("image/") ? "image" : "file",
    url: readString(attachment.url),
    fileName,
    mimeType,
    fileSize: readNumber(attachment.fileSize),
    alt: fileName
  };
}

function normalizeDiscussionSource(value: unknown): Discussion["source"] {
  return readString(value).trim().toLowerCase() === "mcp" ? "mcp" : "portal";
}

function groupRowsByTopic(rows: Record<string, unknown>[]) {
  const grouped = new Map<string, Record<string, unknown>[]>();

  rows.forEach((row) => {
    const topicId = readString(row.topicId);
    const bucket = grouped.get(topicId) ?? [];
    bucket.push(row);
    grouped.set(topicId, bucket);
  });

  return grouped;
}

function discussionUserProfileFromRow(row: Record<string, unknown>, prefix = "") {
  const profileJson = readJsonObject(row[profileField(prefix, "profileJson")]);

  return {
    department: readOptionalString(row[profileField(prefix, "department")]),
    team: readOptionalString(row[profileField(prefix, "team")]),
    jobTitle: readOptionalString(row[profileField(prefix, "jobTitle")]),
    bio: readOptionalString(profileJson.bio),
    location: readOptionalString(profileJson.location),
    journeyLevelKey: readOptionalJourneyLevelKey(row[profileField(prefix, "journeyLevelKey")]),
    journeyTotalPoints: readOptionalNumber(row[profileField(prefix, "journeyTotalPoints")]),
    journeyCommunityContributionPoints: readOptionalNumber(row[profileField(prefix, "journeyCommunityContributionPoints")])
  };
}

function readOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function readOptionalJourneyLevelKey(value: unknown): PortalJourneyLevelKey | undefined {
  const key = readOptionalString(value);
  return portalJourneyLevels.some((level) => level.key === key) ? key as PortalJourneyLevelKey : undefined;
}

function profileField(prefix: string, name: string) {
  return prefix ? `${prefix}${name.slice(0, 1).toUpperCase()}${name.slice(1)}` : name;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

function readNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function readJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function splitList(value: unknown) {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }

  return value.split(",").filter(Boolean);
}

function initials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
