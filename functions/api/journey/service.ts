import {
  buildPortalJourneySnapshot,
  categoryCountsForBadges,
  portalBadgeDefinitions,
  portalCommunityContributionRules,
  portalJourneyLevels,
  resolvePortalJourneyLevel
} from "../../../src/shared/journey.ts";
import type {
  PortalCatalog,
  PortalCurrentUserStatus,
  PortalJourney,
  PortalJourneyBadgeCategory,
  PortalJourneyLevelKey,
  PortalJourneyProfile,
  PortalJourneyUserBadge
} from "../../../src/shared/types.ts";
import { cacheableUserAvatarUrl } from "../users/avatar.ts";
import type {
  PortalLiveDeferredContext,
  PortalLivePublisherEnv
} from "../../../src/shared/portalLivePublisher.ts";
import type { EmitActivityEventInput } from "../activity/service.ts";
import { normalizeIdentityProvider, normalizeRole } from "../values.ts";

type CurrentUser = PortalCatalog["currentUser"];

type JourneyEnv = PortalLivePublisherEnv & {
  AUTH_WORKER_URL?: string;
  DB?: D1Database;
  LITELLM_MASTER_KEY?: string;
  LITELLM_PROVISIONING_KEY?: string;
  LITELLM_URL?: string;
  MCP_APPROVAL_TOKEN?: string;
};

type JourneyContext<TEnv extends JourneyEnv> = EventContext<TEnv, string, unknown>;
type JourneyActivityEmitter = (
  db: D1Database | undefined,
  input: EmitActivityEventInput,
  publishContext?: PortalLiveDeferredContext<PortalLivePublisherEnv>
) => Promise<string | undefined>;
type JourneyActivityOptions = {
  activeGatewayTokenCount?: number;
  authorizedMcpConnectionCount?: number;
  connectedAgentPreference?: PortalJourneyProfile["agentPreference"];
  emitActivityEvent?: JourneyActivityEmitter;
  appsAuthorIndex?: PortalJourneyAppsAuthorIndex;
  syncMonthlyBudget?: (levelKey: PortalJourneyLevelKey) => Promise<void>;
};

type PortalJourneyAppsAuthorIndex = {
  appIds: string[];
  collaboratedAppIds?: string[];
  collaboratedSkillIds?: string[];
  ownedAppIds?: string[];
  ownedSkillIds?: string[];
  skillIds: string[];
};

type PortalJourneyMcpConnectionEvidence = {
  agentPreference?: PortalJourneyProfile["agentPreference"];
  authorizedCount: number;
};

type JourneyDeps<TEnv extends JourneyEnv> = {
  audit(
    db: D1Database | undefined,
    actorType: string,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>
  ): Promise<string>;
  readBody<T>(request: Request): Promise<T>;
  requireDb(db: D1Database | undefined): D1Database;
  resolveCurrentUser(context: JourneyContext<TEnv>): Promise<CurrentUser>;
  readAppsAuthorIndex?(
    context: JourneyContext<TEnv>,
    currentUser: CurrentUser
  ): Promise<PortalJourneyAppsAuthorIndex>;
  readActiveGatewayTokenCount?(
    context: JourneyContext<TEnv>,
    currentUser: CurrentUser
  ): Promise<number>;
  readMcpConnectionEvidence?(
    context: JourneyContext<TEnv>,
    currentUser: CurrentUser
  ): Promise<PortalJourneyMcpConnectionEvidence>;
  emitActivityEvent?: JourneyActivityEmitter;
  syncMonthlyBudget?(
    context: JourneyContext<TEnv>,
    currentUser: CurrentUser,
    levelKey: PortalJourneyLevelKey
  ): Promise<void>;
};

type PortalBadgeEvidence = {
  badgeKey: string;
  metadata?: Record<string, unknown>;
  source: string;
  sourceEventId?: string;
};

export function createJourneyApi<TEnv extends JourneyEnv>(deps: JourneyDeps<TEnv>) {
  const readCurrentUserOverview = async (context: JourneyContext<TEnv>) => {
    const db = deps.requireDb(context.env.DB);
    const currentUser = await deps.resolveCurrentUser(context);
    const [appsAuthorIndex, externalEvidence] = await Promise.all([
      readOptionalAppsAuthorIndex(deps, context, currentUser),
      readOptionalExternalEvidence(deps, context, currentUser)
    ]);
    const journey = await readPortalJourney(db, currentUser, {
      ...externalEvidence,
      emitActivityEvent: deps.emitActivityEvent
        ? (activityDb, input) => deps.emitActivityEvent!(activityDb, input, context)
        : undefined,
      appsAuthorIndex,
      syncMonthlyBudget: deps.syncMonthlyBudget
        ? (levelKey) => deps.syncMonthlyBudget!(context, currentUser, levelKey)
        : undefined
    });

    return {
      currentUser: {
        ...currentUser,
        avatarUrl: cacheableUserAvatarUrl(currentUser.id, currentUser.avatarUrl)
      },
      journey,
      status: currentUserSummaryFromJourney(journey)
    };
  };

  return {
    readCurrentUserOverview,

    async readCurrentUserJourney(context: JourneyContext<TEnv>) {
      return (await readCurrentUserOverview(context)).journey;
    },

    async updateCurrentUserJourneyProfile(context: JourneyContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<{
        agentPreference?: string | null;
        mcpInstalled?: boolean;
      }>(context.request);

      await ensurePortalJourneyDefinitions(db);
      const currentProfile = await readPortalJourneyProfile(db, currentUser.id);
      const nextProfile: PortalJourneyProfile = { ...currentProfile };
      const agentPreference = normalizeAgentPreference(body.agentPreference);

      if (body.agentPreference !== undefined) {
        if (agentPreference) {
          nextProfile.agentPreference = agentPreference;
        } else {
          delete nextProfile.agentPreference;
        }
      }

      if (body.mcpInstalled !== undefined) {
        if (body.mcpInstalled) {
          nextProfile.mcpInstallConfirmedAt = new Date().toISOString();
        } else {
          delete nextProfile.mcpInstallConfirmedAt;
        }
      }

      await db
        .prepare(
          `
          INSERT INTO portal_user_journey_state (user_id, profile_json, updated_at, recomputed_at)
          VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id) DO UPDATE SET
            profile_json = excluded.profile_json,
            updated_at = CURRENT_TIMESTAMP
          `
        )
        .bind(currentUser.id, JSON.stringify(nextProfile))
        .run();

      await deps.audit(db, "user", currentUser.id, "updated journey profile", "user", currentUser.id, {
        agentPreference: nextProfile.agentPreference,
        mcpInstalled: Boolean(nextProfile.mcpInstallConfirmedAt)
      });

      const [appsAuthorIndex, externalEvidence] = await Promise.all([
        readOptionalAppsAuthorIndex(deps, context, currentUser),
        readOptionalExternalEvidence(deps, context, currentUser)
      ]);
      return await readPortalJourney(db, currentUser, {
        ...externalEvidence,
        emitActivityEvent: deps.emitActivityEvent
          ? (activityDb, input) => deps.emitActivityEvent!(activityDb, input, context)
          : undefined,
        appsAuthorIndex,
        syncMonthlyBudget: deps.syncMonthlyBudget
          ? (levelKey) => deps.syncMonthlyBudget!(context, currentUser, levelKey)
          : undefined
      });
    }
  };
}

export async function readPortalJourney(db: D1Database, currentUser: CurrentUser, options: JourneyActivityOptions = {}): Promise<PortalJourney> {
  try {
    await ensurePortalJourneyDefinitions(db);
    const profile = await readPortalJourneyProfile(db, currentUser.id);
    const evidences = await evaluatePortalBadgeEvidence(db, currentUser, profile, options.appsAuthorIndex, {
      activeGatewayTokenCount: options.activeGatewayTokenCount,
      authorizedMcpConnectionCount: options.authorizedMcpConnectionCount,
      connectedAgentPreference: options.connectedAgentPreference
    });
    const previousBadgeKeys = await readPortalUserBadgeKeys(db, currentUser.id);
    const previousLevel = await readPortalJourneyStateLevel(db, currentUser.id);

    await awardPortalBadges(db, currentUser.id, evidences);
    const journey = await readPortalJourneySnapshot(db, currentUser.id, profile, {
      beforePersistLevel: options.syncMonthlyBudget
        ? async (level) => {
          if (previousLevel?.key !== level.key) {
            await options.syncMonthlyBudget!(level.key);
          }
        }
        : undefined
    });
    const newlyAwardedBadges = journey.badges.filter((badge) => !previousBadgeKeys.has(badge.badgeKey));

    await emitJourneyProgressActivity(db, currentUser, journey, newlyAwardedBadges, previousLevel ?? portalJourneyLevels[0], options.emitActivityEvent);
    return journey;
  } catch (error) {
    if (isMissingJourneyTableError(error)) {
      return {
        ...buildPortalJourneySnapshot([]),
        profile: {}
      };
    }

    throw error;
  }
}

export type PortalUserJourneySummary = {
  journeyBadgeCount: number;
  journeyCommunityContributionPoints: number;
  journeyLevelKey: PortalJourneyLevelKey;
  journeyTotalPoints: number;
};

/**
 * Rebuild a user's persisted Journey projection after a server-side mutation.
 *
 * Forum writes do not have an authenticated session for the recipient, so this
 * loads the canonical Portal profile before running the same badge and points
 * evaluation used by the Journey endpoint.
 */
export async function recomputePortalUserJourney(
  db: D1Database,
  userId: string,
  options: Pick<JourneyActivityOptions, "emitActivityEvent"> = {}
): Promise<PortalUserJourneySummary | undefined> {
  const row = await db
    .prepare(
      `
      SELECT
        users.id,
        users.name,
        users.email,
        COALESCE(users.avatar_url, '') AS avatarUrl,
        users.role,
        COALESCE(teams.name, '') AS team,
        profiles.department,
        profiles.job_title AS jobTitle,
        profiles.profile_json AS profileJson,
        profiles.provider,
        profiles.provider_tenant_id AS tenantId,
        profiles.provider_subject_id AS objectId,
        profiles.principal_name AS principalName
      FROM users
      LEFT JOIN teams ON teams.id = users.team_id
      LEFT JOIN user_identity_profiles AS profiles ON profiles.user_id = users.id
      WHERE users.id = ?
        AND users.status != 'deleted'
      LIMIT 1
      `
    )
    .bind(userId)
    .first<Record<string, unknown>>();

  if (!row) {
    return undefined;
  }

  const profile = readJsonObject(row.profileJson);
  const email = readString(row.email);
  const currentUser: CurrentUser = {
    avatarUrl: readOptionalString(row.avatarUrl),
    bio: readOptionalString(profile.bio),
    department: readOptionalString(row.department),
    email,
    id: readString(row.id),
    identity: {
      objectId: readString(row.objectId) || userId,
      principalName: readString(row.principalName) || email,
      provider: normalizeIdentityProvider(row.provider),
      tenantId: readString(row.tenantId)
    },
    jobTitle: readOptionalString(row.jobTitle),
    location: readOptionalString(profile.location),
    name: readString(row.name) || email || userId,
    role: normalizeRole(row.role),
    team: readString(row.team)
  };
  const journey = await readPortalJourney(db, currentUser, options);

  return {
    journeyBadgeCount: journey.badgeCount,
    journeyCommunityContributionPoints: journey.communityContributionPoints,
    journeyLevelKey: journey.level.key,
    journeyTotalPoints: journey.totalPoints
  };
}

export function currentUserSummaryFromJourney(journey: PortalJourney): PortalCurrentUserStatus {
  const badgeKeys = new Set(journey.badges.map((badge) => badge.badgeKey));
  return {
    journeyLevelKey: journey.level.key,
    mcpConnected: badgeKeys.has("mcp_connected"),
    tokenApplied: badgeKeys.has("token_ready"),
    updatedAt: journey.updatedAt
  };
}

export async function ensurePortalJourneyDefinitions(db: D1Database) {
  const levelStatements = portalJourneyLevels.map((level) => (
    db
      .prepare(
        `
        INSERT OR IGNORE INTO portal_journey_levels (
          journey_key,
          version,
          level_key,
          rank,
          name_zh,
          name_en,
          description_zh,
          description_en,
          min_points,
          criteria_json
        )
        VALUES ('default', 'v1', ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(level.key, level.rank, level.nameZh, level.nameEn, level.descriptionZh, level.descriptionEn, level.minPoints, JSON.stringify(level.criteria))
  ));
  const badgeStatements = portalBadgeDefinitions.map((badgeDefinition) => (
    db
      .prepare(
        `
        INSERT OR IGNORE INTO portal_badge_definitions (
          badge_key,
          journey_key,
          version,
          category,
          name_zh,
          name_en,
          description_zh,
          description_en,
          points,
          trigger_type,
          trigger_config_json,
          sort_order
        )
        VALUES (?, 'default', 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        badgeDefinition.key,
        badgeDefinition.category,
        badgeDefinition.nameZh,
        badgeDefinition.nameEn,
        badgeDefinition.descriptionZh,
        badgeDefinition.descriptionEn,
        badgeDefinition.points,
        badgeDefinition.triggerType,
        JSON.stringify(badgeDefinition.triggerConfig),
        badgeDefinition.sortOrder
      )
  ));

  await db.batch([...levelStatements, ...badgeStatements]);
}

export async function readPortalJourneyProfile(db: D1Database, userId: string): Promise<PortalJourneyProfile> {
  const row = await db
    .prepare("SELECT profile_json AS profileJson FROM portal_user_journey_state WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ profileJson?: string }>();
  const profile = readJsonObject(row?.profileJson);

  return {
    agentPreference: normalizeAgentPreference(profile.agentPreference),
    mcpInstallConfirmedAt: readOptionalString(profile.mcpInstallConfirmedAt)
  };
}

export async function evaluatePortalBadgeEvidence(
  db: D1Database,
  currentUser: CurrentUser,
  profile: PortalJourneyProfile,
  appsAuthorIndex?: PortalJourneyAppsAuthorIndex,
  externalEvidence: Pick<JourneyActivityOptions, "activeGatewayTokenCount" | "authorizedMcpConnectionCount" | "connectedAgentPreference"> = {}
): Promise<PortalBadgeEvidence[]> {
  const ownedAppIds = uniqueIds(appsAuthorIndex?.ownedAppIds ?? appsAuthorIndex?.appIds ?? []);
  const ownedSkillIds = uniqueIds(appsAuthorIndex?.ownedSkillIds ?? appsAuthorIndex?.skillIds ?? []);
  const collaboratedProjectIds = uniqueIds([
    ...(appsAuthorIndex?.collaboratedAppIds ?? []).map((projectId) => `app:${projectId}`),
    ...(appsAuthorIndex?.collaboratedSkillIds ?? []).map((projectId) => `skill:${projectId}`)
  ]);
  const [
    profileReady,
    activeToken,
    mcpToken,
    firstTopic,
    firstReply,
    forumTopicCount,
    communitySpark,
    appLaunch,
    skillInstall,
    appsSkillInstall,
    publishedAppsCount,
    reusedAppsCount
  ] = await Promise.all([
    Promise.resolve(hasCompletePortalProfile(currentUser)),
    scalarCount(db, "SELECT COUNT(*) AS count FROM user_usage WHERE user_id = ? AND active_tokens > 0", [currentUser.id]),
    scalarCount(db, "SELECT COUNT(*) AS count FROM audit_logs WHERE actor_type = 'user' AND actor_id = ? AND action = 'issued mcp token'", [currentUser.id]),
    db.prepare("SELECT id, title FROM forum_topics WHERE author_user_id = ? AND status != 'archived' ORDER BY created_at ASC LIMIT 1").bind(currentUser.id).first<{ id: string; title: string }>(),
    db
      .prepare(
        `
        SELECT forum_posts.id AS id, forum_topics.title AS title
        FROM forum_posts
        JOIN forum_topics ON forum_topics.id = forum_posts.topic_id
        WHERE forum_posts.author_user_id = ?
          AND ${forumReplyEvidencePredicate("forum_posts")}
          AND forum_topics.status != 'archived'
        ORDER BY forum_posts.created_at ASC
        LIMIT 1
        `
      )
      .bind(currentUser.id)
      .first<{ id: string; title: string }>(),
    scalarCount(
      db,
      "SELECT COUNT(*) AS count FROM forum_topics WHERE author_user_id = ? AND status != 'archived'",
      [currentUser.id]
    ),
    db
      .prepare(
        `
        SELECT forum_topics.id AS id,
               forum_topics.title AS title,
               forum_topics.reply_count AS replies,
               COUNT(forum_post_likes.user_id) AS reactions
        FROM forum_topics
        JOIN forum_posts AS root_posts ON root_posts.id = (
          SELECT id
          FROM forum_posts
          WHERE topic_id = forum_topics.id
            AND parent_post_id IS NULL
          ORDER BY created_at ASC
          LIMIT 1
        )
        LEFT JOIN forum_post_likes ON forum_post_likes.post_id = root_posts.id
        WHERE forum_topics.author_user_id = ?
          AND forum_topics.status != 'archived'
        GROUP BY forum_topics.id
        HAVING forum_topics.reply_count >= 5 OR COUNT(forum_post_likes.user_id) >= 10
        ORDER BY forum_topics.reply_count DESC, reactions DESC
        LIMIT 1
        `
      )
      .bind(currentUser.id)
      .first<{ id: string; title: string; replies: number; reactions: number }>(),
    scalarCount(
      db,
      "SELECT COUNT(*) AS count FROM audit_logs WHERE actor_type = 'user' AND actor_id = ? AND action IN ('issued direct jump token', 'app.visit_url')",
      [currentUser.id]
    ),
    scalarCount(
      db,
      `
      SELECT COUNT(*) AS count
      FROM publication_installations
      JOIN publication_listings ON publication_listings.id = publication_installations.listing_id
      WHERE publication_installations.user_id = ?
        AND publication_listings.listing_type = 'skill'
      `,
      [currentUser.id]
    ),
    scalarCount(
      db,
      `
      SELECT COUNT(*) AS count
      FROM publication_installations
      JOIN publication_listings ON publication_listings.id = publication_installations.listing_id
      WHERE publication_installations.user_id = ?
        AND publication_listings.target_plane = 'apps'
        AND publication_listings.listing_type = 'skill'
      `,
      [currentUser.id]
    ),
    countPublishedAppsProjects(db, currentUser.id, ownedAppIds, ownedSkillIds, !appsAuthorIndex),
    countReusedAppsProjects(db, currentUser.id, ownedAppIds, ownedSkillIds, !appsAuthorIndex)
  ]);

  const evidences: PortalBadgeEvidence[] = [];
  if (profileReady) {
    evidences.push({ badgeKey: "profile_ready", source: "profile", metadata: { completed: true } });
  }
  const agentPreference = profile.agentPreference ?? externalEvidence.connectedAgentPreference;
  if (agentPreference) {
    evidences.push({
      badgeKey: "agent_declared",
      source: profile.agentPreference ? "profile" : "auth",
      metadata: { agentPreference }
    });
  }
  const activeGatewayTokens = Math.max(activeToken, externalEvidence.activeGatewayTokenCount ?? 0);
  if (activeGatewayTokens > 0) {
    evidences.push({ badgeKey: "token_ready", source: "gateway", metadata: { activeTokens: activeGatewayTokens } });
  }
  const authorizedMcpConnections = externalEvidence.authorizedMcpConnectionCount ?? 0;
  if (profile.mcpInstallConfirmedAt || mcpToken > 0 || authorizedMcpConnections > 0) {
    evidences.push({
      badgeKey: "mcp_connected",
      source: profile.mcpInstallConfirmedAt ? "profile" : authorizedMcpConnections > 0 ? "auth" : "audit",
      metadata: {
        authorizedConnections: authorizedMcpConnections,
        mcpInstallConfirmedAt: profile.mcpInstallConfirmedAt,
        mcpTokenEvents: mcpToken
      }
    });
  }
  if (firstTopic?.id) {
    evidences.push({ badgeKey: "first_post", source: "forum", sourceEventId: firstTopic.id, metadata: { topicTitle: firstTopic.title } });
  }
  if (firstReply?.id) {
    evidences.push({ badgeKey: "first_reply", source: "forum", sourceEventId: firstReply.id, metadata: { topicTitle: firstReply.title } });
  }
  if (forumTopicCount >= 5) {
    evidences.push({ badgeKey: "forum_active", source: "forum", metadata: { topics: forumTopicCount } });
  }
  if (communitySpark?.id) {
    evidences.push({ badgeKey: "community_spark", source: "forum", sourceEventId: communitySpark.id, metadata: { topicTitle: communitySpark.title, replies: readNumber(communitySpark.replies), reactions: readNumber(communitySpark.reactions) } });
  }
  if (appLaunch > 0) {
    evidences.push({ badgeKey: "first_app_launch", source: "audit", metadata: { launches: appLaunch } });
  }
  if (skillInstall > 0) {
    evidences.push({ badgeKey: "first_skill_install", source: "market", metadata: { installs: skillInstall } });
  }
  if (appsSkillInstall > 0) {
    evidences.push({ badgeKey: "apps_skill_user", source: "market", metadata: { installs: appsSkillInstall } });
  }
  if (appLaunch > 0 && appsSkillInstall > 0) {
    evidences.push({ badgeKey: "workflow_explorer", source: "computed", metadata: { surfaces: 2 } });
  }
  const appsAppCount = ownedAppIds.length;
  const appsSkillCount = ownedSkillIds.length;
  if (appsAppCount > 0 || appsSkillCount > 0) {
    evidences.push({
      badgeKey: "first_apps_draft",
      source: "apps",
      metadata: { apps: appsAppCount, skills: appsSkillCount }
    });
  }
  if (appsSkillCount > 0) {
    evidences.push({
      badgeKey: "skill_maker",
      source: "apps",
      metadata: { skills: appsSkillCount }
    });
  }
  if (appsAppCount > 0) {
    evidences.push({
      badgeKey: "app_maker",
      source: "apps",
      metadata: { apps: appsAppCount }
    });
  }
  if (publishedAppsCount >= 1) {
    evidences.push({ badgeKey: "first_published_capability", source: "market", metadata: { publishedAppss: publishedAppsCount } });
  }
  if (publishedAppsCount >= 2) {
    evidences.push({ badgeKey: "published_two_appss", source: "market", metadata: { publishedAppss: publishedAppsCount } });
  }
  if (reusedAppsCount > 0) {
    evidences.push({ badgeKey: "reused_by_team", source: "market", metadata: { reusedAppss: reusedAppsCount, distinctUsersRequired: 5 } });
  }
  if (collaboratedProjectIds.length >= 3) {
    evidences.push({
      badgeKey: "collaboration_master",
      source: "apps",
      metadata: { collaboratedProjects: collaboratedProjectIds.length }
    });
  }

  return evidences;
}

export async function awardPortalBadges(db: D1Database, userId: string, evidences: PortalBadgeEvidence[]) {
  if (evidences.length === 0) {
    return;
  }

  await db.batch(evidences.map((evidence) => (
    db
      .prepare(
        `
        INSERT OR IGNORE INTO portal_user_badges (user_id, badge_key, source, source_event_id, metadata_json)
        VALUES (?, ?, ?, ?, ?)
        `
      )
      .bind(userId, evidence.badgeKey, evidence.source, evidence.sourceEventId ?? null, JSON.stringify(evidence.metadata ?? {}))
  )));
}

export async function readPortalJourneySnapshot(
  db: D1Database,
  userId: string,
  profile: PortalJourneyProfile,
  options: { beforePersistLevel?: (level: PortalJourney["level"]) => Promise<void> } = {}
): Promise<PortalJourney> {
  const [badgeRows, forumTopicCount, forumReplyCount, contributionTagPoints] = await Promise.all([
    db
      .prepare(
        `
      SELECT
        portal_user_badges.badge_key AS badgeKey,
        portal_badge_definitions.category,
        portal_badge_definitions.name_zh AS nameZh,
        portal_badge_definitions.name_en AS nameEn,
        portal_badge_definitions.description_zh AS descriptionZh,
        portal_badge_definitions.description_en AS descriptionEn,
        portal_badge_definitions.points,
        portal_user_badges.source,
        portal_user_badges.source_event_id AS sourceEventId,
        portal_user_badges.metadata_json AS metadataJson,
        portal_user_badges.awarded_at AS awardedAt
      FROM portal_user_badges
      JOIN portal_badge_definitions ON portal_badge_definitions.badge_key = portal_user_badges.badge_key
      WHERE portal_user_badges.user_id = ?
        AND portal_badge_definitions.active = 1
      ORDER BY portal_user_badges.awarded_at DESC, portal_badge_definitions.sort_order
      `
      )
      .bind(userId)
      .all<Record<string, unknown>>(),
    scalarCount(
      db,
      "SELECT COUNT(*) AS count FROM forum_topics WHERE author_user_id = ? AND status != 'archived'",
      [userId]
    ),
    scalarCount(
      db,
      `
      SELECT COUNT(*) AS count
      FROM forum_posts
      JOIN forum_topics ON forum_topics.id = forum_posts.topic_id
      WHERE forum_posts.author_user_id = ?
        AND ${forumReplyEvidencePredicate("forum_posts")}
        AND forum_topics.status != 'archived'
      `,
      [userId]
    ),
    scalarCount(
      db,
      "SELECT COALESCE(SUM(points), 0) AS count FROM forum_contributor_awards WHERE recipient_user_id = ?",
      [userId]
    )
  ]);
  const badges: PortalJourneyUserBadge[] = (badgeRows.results ?? []).map((row) => ({
    badgeKey: readString(row.badgeKey),
    category: normalizeBadgeCategory(row.category),
    nameZh: readString(row.nameZh),
    nameEn: readString(row.nameEn),
    descriptionZh: readString(row.descriptionZh),
    descriptionEn: readString(row.descriptionEn),
    points: readNumber(row.points),
    source: readString(row.source),
    sourceEventId: readOptionalString(row.sourceEventId),
    metadata: readJsonObject(row.metadataJson),
    awardedAt: readString(row.awardedAt)
  }));
  const communityContributionBreakdown = {
    contributionTagPoints,
    replyPoints: forumReplyCount * portalCommunityContributionRules.replyPoints,
    topicPoints: forumTopicCount * portalCommunityContributionRules.topicPoints
  };
  const communityContributionPoints = Object.values(communityContributionBreakdown)
    .reduce((sum, points) => sum + points, 0);
  const totalPoints = badges.reduce((sum, badgeItem) => sum + badgeItem.points, communityContributionPoints);
  const categoryCounts = categoryCountsForBadges(badges);
  const level = resolvePortalJourneyLevel(totalPoints, badges);
  const earnedKeys = new Set(badges.map((badgeItem) => badgeItem.badgeKey));
  const nextBadges = portalBadgeDefinitions.filter((definition) => !earnedKeys.has(definition.key)).slice(0, 4);
  const updatedAt = new Date().toISOString();

  await options.beforePersistLevel?.(level);

  await db
    .prepare(
      `
      INSERT INTO portal_user_journey_state (
        user_id,
        journey_key,
        version,
        current_level_key,
        total_points,
        community_contribution_points,
        badge_count,
        category_counts_json,
        next_badges_json,
        profile_json,
        recomputed_at,
        updated_at
      )
      VALUES (?, 'default', 'v1', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        current_level_key = excluded.current_level_key,
        total_points = excluded.total_points,
        community_contribution_points = excluded.community_contribution_points,
        badge_count = excluded.badge_count,
        category_counts_json = excluded.category_counts_json,
        next_badges_json = excluded.next_badges_json,
        profile_json = excluded.profile_json,
        recomputed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      `
    )
    .bind(userId, level.key, totalPoints, communityContributionPoints, badges.length, JSON.stringify(categoryCounts), JSON.stringify(nextBadges.map((badgeDefinition) => badgeDefinition.key)), JSON.stringify(profile))
    .run();

  return {
    level,
    levels: portalJourneyLevels,
    badgeDefinitions: portalBadgeDefinitions,
    badges,
    profile,
    communityContributionBreakdown,
    communityContributionPoints,
    totalPoints,
    badgeCount: badges.length,
    categoryCounts,
    nextBadges,
    updatedAt
  };
}

async function readPortalUserBadgeKeys(db: D1Database, userId: string) {
  const rows = await db
    .prepare(
      `
      SELECT portal_user_badges.badge_key AS badgeKey
      FROM portal_user_badges
      JOIN portal_badge_definitions
        ON portal_badge_definitions.badge_key = portal_user_badges.badge_key
      WHERE portal_user_badges.user_id = ?
        AND portal_badge_definitions.active = 1
      `
    )
    .bind(userId)
    .all<Record<string, unknown>>();

  return new Set((rows.results ?? []).map((row) => readString(row.badgeKey)).filter(Boolean));
}

async function readPortalJourneyStateLevel(db: D1Database, userId: string) {
  const row = await db
    .prepare("SELECT current_level_key AS currentLevelKey FROM portal_user_journey_state WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ currentLevelKey?: string }>();

  return journeyLevelFromKey(row?.currentLevelKey);
}

async function emitJourneyProgressActivity(
  db: D1Database,
  currentUser: CurrentUser,
  journey: PortalJourney,
  newlyAwardedBadges: PortalJourneyUserBadge[],
  previousLevel: PortalJourney["level"],
  emitActivityEvent?: JourneyActivityEmitter
) {
  if (!emitActivityEvent) {
    return;
  }

  const activityEvents: EmitActivityEventInput[] = newlyAwardedBadges.map((badge) => ({
    scenario: "community",
    actionType: "journey.badge.awarded",
    actor: currentUser,
    target: {
      type: "journey_badge",
      id: badge.badgeKey,
      title: badge.nameZh
    },
    summary: `${currentUser.name} 获得了 ${badge.nameZh} Badge`,
    metadata: {
      badgeKey: badge.badgeKey,
      badgeNameZh: badge.nameZh,
      badgeNameEn: badge.nameEn,
      category: badge.category,
      points: badge.points
    },
    sourceEventId: `journey.badge.awarded:${currentUser.id}:${badge.badgeKey}`
  }));

  if (journey.level.rank > previousLevel.rank) {
    activityEvents.push({
      scenario: "community",
      actionType: "journey.level.upgraded",
      actor: currentUser,
      target: {
        type: "journey_level",
        id: journey.level.key,
        title: journey.level.nameZh
      },
      summary: `${currentUser.name} 升级为 Level ${journey.level.rank} · ${journey.level.nameZh}`,
      metadata: {
        previousLevelKey: previousLevel.key,
        levelKey: journey.level.key,
        levelNameZh: journey.level.nameZh,
        levelNameEn: journey.level.nameEn,
        levelRank: journey.level.rank
      },
      sourceEventId: `journey.level.upgraded:${currentUser.id}:${journey.level.key}`
    });
  }

  for (const activityEvent of activityEvents) {
    await emitActivityEvent(db, activityEvent);
  }
}

function journeyLevelFromKey(value: unknown) {
  const key = readString(value);
  return portalJourneyLevels.find((level) => level.key === key);
}

async function readOptionalAppsAuthorIndex<TEnv extends JourneyEnv>(
  deps: JourneyDeps<TEnv>,
  context: JourneyContext<TEnv>,
  currentUser: CurrentUser
) {
  if (!deps.readAppsAuthorIndex) {
    return undefined;
  }

  try {
    return await deps.readAppsAuthorIndex(context, currentUser);
  } catch {
    return undefined;
  }
}

async function readOptionalExternalEvidence<TEnv extends JourneyEnv>(
  deps: JourneyDeps<TEnv>,
  context: JourneyContext<TEnv>,
  currentUser: CurrentUser
) {
  const [activeGatewayTokenCount, mcpConnectionEvidence] = await Promise.all([
    readOptionalCount(() => deps.readActiveGatewayTokenCount?.(context, currentUser)),
    readOptionalMcpConnectionEvidence(() => deps.readMcpConnectionEvidence?.(context, currentUser))
  ]);

  return {
    activeGatewayTokenCount,
    authorizedMcpConnectionCount: mcpConnectionEvidence.authorizedCount,
    connectedAgentPreference: mcpConnectionEvidence.agentPreference
  };
}

async function readOptionalMcpConnectionEvidence(
  reader: () => Promise<PortalJourneyMcpConnectionEvidence> | undefined
): Promise<PortalJourneyMcpConnectionEvidence> {
  try {
    const evidence = await reader();
    return {
      agentPreference: normalizeAgentPreference(evidence?.agentPreference),
      authorizedCount: Math.max(0, readNumber(evidence?.authorizedCount))
    };
  } catch {
    return { authorizedCount: 0 };
  }
}

async function readOptionalCount(reader: () => Promise<number> | undefined) {
  try {
    const count = await reader();
    return Math.max(0, readNumber(count));
  } catch {
    return 0;
  }
}

async function scalarCount(db: D1Database, sql: string, bindings: Array<number | string | null>) {
  const statement = db.prepare(sql);
  const row = await statement.bind(...bindings).first<{ count?: number }>();
  return readNumber(row?.count);
}

function countPublishedAppsProjects(
  db: D1Database,
  currentUserId: string,
  ownedAppIds: string[],
  ownedSkillIds: string[],
  allowSubmitterFallback: boolean
) {
  const ownership = appsListingOwnershipCondition(currentUserId, ownedAppIds, ownedSkillIds, allowSubmitterFallback);
  return scalarCount(
    db,
    `
    SELECT COUNT(DISTINCT publication_listings.id) AS count
    FROM publication_listings
    WHERE publication_listings.target_plane = 'apps'
      AND publication_listings.effective_status = 'listed'
      AND ${ownership.sql}
    `,
    ownership.bindings
  );
}

function countReusedAppsProjects(
  db: D1Database,
  currentUserId: string,
  ownedAppIds: string[],
  ownedSkillIds: string[],
  allowSubmitterFallback: boolean
) {
  const ownership = appsListingOwnershipCondition(currentUserId, ownedAppIds, ownedSkillIds, allowSubmitterFallback);
  return scalarCount(
    db,
    `
    WITH project_usage AS (
      SELECT publication_listings.id AS project_id,
             publication_installations.user_id AS user_id
      FROM publication_listings
      JOIN publication_installations
        ON publication_installations.listing_id = publication_listings.id
      WHERE publication_listings.target_plane = 'apps'
        AND publication_listings.effective_status = 'listed'
        AND publication_installations.install_type != 'bookmark'
        AND ${ownership.sql}
        AND publication_installations.user_id != ?

      UNION

      SELECT publication_listings.id AS project_id,
             audit_logs.actor_id AS user_id
      FROM publication_listings
      JOIN audit_logs
        ON publication_listings.listing_type = 'app'
       AND (
         (
           audit_logs.action = 'issued direct jump token'
           AND audit_logs.target_type = 'app'
           AND audit_logs.target_id = publication_listings.target_id
         )
         OR (
           audit_logs.action = 'app.visit_url'
           AND audit_logs.target_type = 'publication_listing'
           AND audit_logs.target_id = publication_listings.id
         )
       )
      WHERE publication_listings.target_plane = 'apps'
        AND publication_listings.effective_status = 'listed'
        AND ${ownership.sql}
        AND audit_logs.actor_id != ?
    )
    SELECT COUNT(*) AS count
    FROM (
      SELECT project_id
      FROM project_usage
      GROUP BY project_id
      HAVING COUNT(DISTINCT user_id) >= 5
    )
    `,
    [
      ...ownership.bindings,
      currentUserId,
      ...ownership.bindings,
      currentUserId
    ]
  );
}

function appsListingOwnershipCondition(
  currentUserId: string,
  ownedAppIds: string[],
  ownedSkillIds: string[],
  allowSubmitterFallback: boolean
) {
  const clauses: string[] = [];
  const bindings: string[] = [];

  if (allowSubmitterFallback) {
    clauses.push("publication_listings.created_by_user_id = ?");
    bindings.push(currentUserId);
  }

  if (ownedAppIds.length > 0) {
    clauses.push(`(publication_listings.listing_type = 'app' AND publication_listings.target_id IN (${ownedAppIds.map(() => "?").join(", ")}))`);
    bindings.push(...ownedAppIds);
  }

  if (ownedSkillIds.length > 0) {
    clauses.push(`(publication_listings.listing_type = 'skill' AND publication_listings.target_id IN (${ownedSkillIds.map(() => "?").join(", ")}))`);
    bindings.push(...ownedSkillIds);
  }

  return {
    bindings,
    sql: clauses.length > 0 ? `(${clauses.join(" OR ")})` : "(1 = 0)"
  };
}

function uniqueIds(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function forumReplyEvidencePredicate(postAlias: string) {
  return `${postAlias}.id <> (
    SELECT root_post.id
    FROM forum_posts AS root_post
    WHERE root_post.topic_id = ${postAlias}.topic_id
    ORDER BY root_post.created_at ASC, root_post.id ASC
    LIMIT 1
  )`;
}

function hasCompletePortalProfile(user: CurrentUser) {
  return Boolean(user.name?.trim() && user.avatarUrl?.trim() && user.bio?.trim());
}

export function normalizeAgentPreference(value: unknown): PortalJourneyProfile["agentPreference"] {
  const normalized = (readOptionalString(value) ?? "").toLowerCase().replaceAll("_", "-");
  if (normalized === "chatgpt" || normalized === "openai") {
    return "codex";
  }

  return normalized === "workbuddy" || normalized === "codex" || normalized === "claude-code" || normalized === "cursor" ? normalized : undefined;
}

function normalizeBadgeCategory(value: unknown): PortalJourneyBadgeCategory {
  const normalized = readString(value);
  return normalized === "foundation" || normalized === "community" || normalized === "usage" || normalized === "builder" || normalized === "impact"
    ? normalized
    : "foundation";
}

function isMissingJourneyTableError(error: unknown) {
  return error instanceof Error && /no such table:\s*portal_(?:journey|badge)/i.test(error.message);
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
