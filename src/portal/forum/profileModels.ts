import type {
  Discussion,
  DiscussionMention,
  DiscussionReply,
  PortalCatalog,
  PortalJourneyLevelKey
} from "../../shared/types";
import { formatPortalJourneyLevelLabel, portalJourneyLevels } from "../../shared/journey.ts";
import type { ProfileModalUser } from "../components/ProfileModal";
import type { Locale } from "../i18n";
import type { ForumDiscussion } from "./forumAnonymousIdentity";

export function buildCommunityParticipantCount(discussions: Discussion[]) {
  return new Set(
    discussions.flatMap((discussion) => [
      discussion.authorId ?? discussion.author,
      ...(discussion.replyPosts?.map((reply) => reply.authorId ?? reply.author) ?? [])
    ])
  ).size;
}

export function buildParticipants(discussion: ForumDiscussion) {
  const participants = [
    ...(discussion.anonymous ? [] : [profileFromDiscussionAuthor(discussion)]),
    ...(discussion.replyPosts?.filter((reply) => !reply.anonymous).map((reply) => profileFromReply(reply, discussion)) ?? [])
  ];
  const seen = new Set<string>();

  return participants.filter((participant) => {
    const key = participant.id || participant.email || participant.name;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  }).slice(0, 8);
}

export function profileFromDiscussionAuthor(discussion: Discussion): ProfileModalUser {
  return {
    id: discussion.authorId ?? `discussion-author:${discussion.author}`,
    name: discussion.author,
    email: discussion.authorEmail ?? "",
    avatarUrl: discussion.authorAvatarUrl,
    team: "",
    department: discussion.department,
    jobTitle: discussion.jobTitle,
    bio: discussion.bio,
    location: discussion.location,
    journeyLevelKey: discussion.journeyLevelKey,
    journeyTotalPoints: discussion.journeyTotalPoints,
    journeyCommunityContributionPoints: discussion.journeyCommunityContributionPoints,
    role: "member"
  };
}

export function profileFromReply(reply: DiscussionReply, discussion: Discussion): ProfileModalUser {
  return {
    id: reply.authorId ?? `reply-author:${reply.author}`,
    name: reply.author,
    email: reply.authorEmail ?? "",
    avatarUrl: reply.authorAvatarUrl,
    team: "",
    department: reply.department,
    jobTitle: reply.jobTitle,
    bio: reply.bio,
    location: reply.location,
    journeyLevelKey: reply.journeyLevelKey,
    journeyTotalPoints: reply.journeyTotalPoints,
    journeyCommunityContributionPoints: reply.journeyCommunityContributionPoints,
    role: "member"
  };
}

export function profileFromMention(mention: DiscussionMention, discussion: Discussion): ProfileModalUser {
  return {
    id: mention.userId,
    name: mention.name || mention.text.replace(/^@/, ""),
    email: mention.email ?? "",
    avatarUrl: mention.avatarUrl,
    team: "",
    department: mention.department,
    jobTitle: mention.jobTitle,
    bio: mention.bio,
    location: mention.location,
    journeyLevelKey: mention.journeyLevelKey,
    journeyTotalPoints: mention.journeyTotalPoints,
    journeyCommunityContributionPoints: mention.journeyCommunityContributionPoints,
    role: "member"
  };
}

export function communityLevelLabel(levelKey: PortalJourneyLevelKey | undefined, locale: Locale) {
  const level = portalJourneyLevels.find((item) => item.key === levelKey) ?? portalJourneyLevels[0];
  return formatPortalJourneyLevelLabel(level, locale);
}

export function profileSignature(user: ProfileModalUser, locale: Locale) {
  return user.bio?.trim() || communityLevelLabel(user.journeyLevelKey, locale);
}

export function localizedJourneyLevelName(level: PortalCatalog["journey"]["level"], locale: Locale) {
  return locale === "zh-CN" ? level.nameZh : level.nameEn;
}
