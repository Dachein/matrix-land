import { schedulePortalLiveEvent } from "../../../src/shared/portalLivePublisher.ts";
import { portalCommunityContributionRules } from "../../../src/shared/journey.ts";
import {
  notificationInsertStatement,
  notificationWriteWithId
} from "../notifications/writes.ts";
import { scheduleContributorAwardEmail } from "./contributorAwardEmail.ts";
import { requireCommunityAdminUser } from "./moderation.ts";
import type { CurrentUser, ForumContext, ForumDeps, ForumEnv } from "./types.ts";

export const FORUM_CONTRIBUTOR_AWARD_POINT_OPTIONS = portalCommunityContributionRules.contributionTagPoints;

type ContributorAwardTarget = {
  postId: string;
  recipientAvatarUrl: string;
  recipientEmail: string;
  recipientName: string;
  recipientStatus: string;
  recipientTeam: string;
  recipientTeamId: string;
  recipientUserId: string;
  topicId: string;
  topicTitle: string;
};

export function createForumContributorAwardApi<TEnv extends ForumEnv>(deps: ForumDeps<TEnv>) {
  return {
    async awardForumTopicContributor(context: ForumContext<TEnv>, rawTopicId: string) {
      const topicId = decodeURIComponent(rawTopicId);
      return awardForumContributor(context, deps, await readTopicAwardTarget(
        deps.requireDb(context.env.DB),
        topicId
      ), "forum_topic_not_found");
    },

    async awardForumReplyContributor(context: ForumContext<TEnv>, rawTopicId: string, rawPostId: string) {
      const topicId = decodeURIComponent(rawTopicId);
      const postId = decodeURIComponent(rawPostId);
      return awardForumContributor(context, deps, await readReplyAwardTarget(
        deps.requireDb(context.env.DB),
        topicId,
        postId
      ), "forum_reply_not_found");
    }
  };
}

async function awardForumContributor<TEnv extends ForumEnv>(
  context: ForumContext<TEnv>,
  deps: ForumDeps<TEnv>,
  target: ContributorAwardTarget | null,
  notFoundCode: string
) {
  const db = deps.requireDb(context.env.DB);
  const currentUser = await deps.resolveCurrentUser(context);
  await requireCommunityAdminUser(db, currentUser, deps);

  if (!target) {
    throw deps.httpError(404, notFoundCode);
  }

  if (currentUser.id === target.recipientUserId) {
    throw deps.httpError(400, "forum_contributor_self_award_not_allowed");
  }

  const existing = await db
    .prepare("SELECT id FROM forum_contributor_awards WHERE post_id = ? LIMIT 1")
    .bind(target.postId)
    .first<{ id?: string }>();
  if (existing?.id) {
    throw deps.httpError(409, "forum_contributor_award_exists");
  }

  const body = await deps.readBody<{ note?: string; points?: number }>(context.request);
  const note = deps.requireText(body.note, "missing_forum_contributor_award_note", 500);
  const points = requireContributorAwardPoints(body.points, deps);

  const awardId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const notification = currentUser.id === target.recipientUserId
    ? undefined
    : notificationWriteWithId({
        actorUserId: currentUser.id,
        dedupeKey: `forum.contributor_awarded:${target.postId}:${target.recipientUserId}`,
        entityId: target.postId,
        entityType: "forum_post",
        href: `#/posts/${encodeURIComponent(target.topicId)}`,
        metadata: {
          awardId,
          contributionTag: true,
          note,
          points,
          postId: target.postId,
          topicId: target.topicId,
          topicTitle: target.topicTitle
        },
        notificationType: "forum.contributor_awarded",
        parentId: target.topicId,
        parentType: "forum_topic",
        recipientUserId: target.recipientUserId,
        summary: `${currentUser.name} 给你的内容添加了社区贡献（+${points}）`
      });
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `
        INSERT INTO forum_contributor_awards (
          id,
          topic_id,
          post_id,
          recipient_user_id,
          awarded_by_user_id,
          points,
          note,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        awardId,
        target.topicId,
        target.postId,
        target.recipientUserId,
        currentUser.id,
        points,
        note,
        createdAt
      )
  ];

  if (notification) {
    statements.push(notificationInsertStatement(db, notification));
  }

  await db.batch(statements);
  const journey = await deps.refreshUserJourneyState(db, target.recipientUserId, context);
  if (notification) {
    schedulePortalLiveEvent(context, { notificationId: notification.id });
    scheduleContributorAwardEmail(context, {
      currentUser,
      note,
      points,
      target: {
        recipientEmail: target.recipientEmail,
        recipientName: target.recipientName,
        recipientStatus: target.recipientStatus,
        recipientUserId: target.recipientUserId,
        topicId: target.topicId,
        topicTitle: target.topicTitle
      }
    });
  }
  const recipientActor: CurrentUser = {
    ...currentUser,
    avatarUrl: target.recipientAvatarUrl || undefined,
    email: target.recipientEmail,
    id: target.recipientUserId,
    name: target.recipientName || target.recipientUserId,
    team: target.recipientTeam
  };
  await deps.emitActivityEvent(db, {
    scenario: "community",
    actionType: "forum.contribution.awarded",
    actor: recipientActor,
    target: {
      type: "forum_post",
      id: target.postId,
      title: target.topicTitle
    },
    parent: {
      type: "forum_topic",
      id: target.topicId,
      title: target.topicTitle
    },
    summary: `${recipientActor.name} 获得了社区贡献（+${points}）：${activityNote(note)}`,
    href: `#/community/${encodeURIComponent(target.topicId)}`,
    teamId: target.recipientTeamId || context.env.DEFAULT_TEAM_ID,
    metadata: {
      awardId,
      awardedByName: currentUser.name,
      awardedByUserId: currentUser.id,
      contributionTag: true,
      note,
      points,
      postId: target.postId,
      topicId: target.topicId,
      topicTitle: target.topicTitle
    },
    sourceEventId: `forum.contribution.awarded:${awardId}`
  }, context);
  await deps.audit(db, "user", currentUser.id, "tagged forum contribution", "forum_post", target.postId, {
    awardId,
    contributionTag: true,
    note,
    points,
    recipientUserId: target.recipientUserId,
    topicId: target.topicId
  });

  return {
    award: {
      id: awardId,
      awardedByName: currentUser.name,
      awardedByUserId: currentUser.id,
      createdAt,
      note,
      points
    },
    postId: target.postId,
    recipientUserId: target.recipientUserId,
    topicId: target.topicId,
    ...journey
  };
}

function requireContributorAwardPoints<TEnv extends ForumEnv>(rawPoints: number | undefined, deps: ForumDeps<TEnv>) {
  const points = Number(rawPoints);
  if (
    !Number.isInteger(points)
    || points < portalCommunityContributionRules.contributionTagCustomMin
    || points > portalCommunityContributionRules.contributionTagCustomMax
  ) {
    throw deps.httpError(400, "invalid_forum_contributor_award_points");
  }

  return points;
}

function activityNote(note: string) {
  return note.length <= 180 ? note : `${note.slice(0, 179).trimEnd()}…`;
}

function readTopicAwardTarget(db: D1Database, topicId: string) {
  return db
    .prepare(
      `
      SELECT
        forum_topics.id AS topicId,
        forum_topics.title AS topicTitle,
        forum_posts.id AS postId,
        forum_posts.author_user_id AS recipientUserId,
        recipient.name AS recipientName,
        recipient.email AS recipientEmail,
        recipient.avatar_url AS recipientAvatarUrl,
        recipient.status AS recipientStatus,
        COALESCE(recipient_team.name, '') AS recipientTeam,
        COALESCE(recipient.team_id, '') AS recipientTeamId
      FROM forum_topics
      JOIN forum_posts ON forum_posts.id = (
        SELECT root_posts.id
        FROM forum_posts AS root_posts
        WHERE root_posts.topic_id = forum_topics.id
          AND root_posts.parent_post_id IS NULL
        ORDER BY root_posts.created_at ASC
        LIMIT 1
      )
      JOIN users AS recipient ON recipient.id = forum_posts.author_user_id
      LEFT JOIN teams AS recipient_team ON recipient_team.id = recipient.team_id
      WHERE forum_topics.id = ?
        AND forum_topics.status != 'archived'
      LIMIT 1
      `
    )
    .bind(topicId)
    .first<ContributorAwardTarget>();
}

function readReplyAwardTarget(db: D1Database, topicId: string, postId: string) {
  return db
    .prepare(
      `
      SELECT
        forum_topics.id AS topicId,
        forum_topics.title AS topicTitle,
        forum_posts.id AS postId,
        forum_posts.author_user_id AS recipientUserId,
        recipient.name AS recipientName,
        recipient.email AS recipientEmail,
        recipient.avatar_url AS recipientAvatarUrl,
        recipient.status AS recipientStatus,
        COALESCE(recipient_team.name, '') AS recipientTeam,
        COALESCE(recipient.team_id, '') AS recipientTeamId
      FROM forum_posts
      JOIN users AS recipient ON recipient.id = forum_posts.author_user_id
      LEFT JOIN teams AS recipient_team ON recipient_team.id = recipient.team_id
      JOIN forum_topics ON forum_topics.id = forum_posts.topic_id
      WHERE forum_posts.id = ?
        AND forum_posts.topic_id = ?
        AND forum_posts.parent_post_id IS NOT NULL
        AND forum_topics.status != 'archived'
      LIMIT 1
      `
    )
    .bind(postId, topicId)
    .first<ContributorAwardTarget>();
}
