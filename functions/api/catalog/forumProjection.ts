import { buildForumDiscussions } from "../forum/readModel.ts";
import type { ForumDiscussionPage, ForumDiscussionQuery } from "../../../src/shared/types.ts";
import type { CurrentUser, UserProfileColumns } from "./types.ts";

export function selectedForumTopicIdsSql() {
  return `
          SELECT id
          FROM forum_topics
          WHERE status = 'open'
          ORDER BY is_pinned DESC, pinned_at DESC, ${forumTopicActivityTimestampSql()} DESC
          LIMIT ${CATALOG_FORUM_TOPIC_LIMIT}
        `;
}

export const CATALOG_FORUM_TOPIC_LIMIT = 30;
export const FORUM_TOPIC_DEFAULT_PAGE_LIMIT = 20;
export const FORUM_TOPIC_MAX_PAGE_LIMIT = 30;
const FORUM_PINNED_TOPIC_LIMIT = 10;

type ForumDiscussionCursor = {
  id: string;
  lastActive: string;
};

type ForumTopicScope = string | string[] | undefined;

function forumTopicActivityTimestampSql(topicAlias = "forum_topics") {
  return `MAX(
            COALESCE(NULLIF(${topicAlias}.last_active_at, ''), ''),
            COALESCE(NULLIF(${topicAlias}.updated_at, ''), ''),
            COALESCE(NULLIF(${topicAlias}.created_at, ''), ''),
            COALESCE((
              SELECT MAX(COALESCE(NULLIF(activity_posts.updated_at, ''), activity_posts.created_at))
              FROM forum_posts AS activity_posts
              WHERE activity_posts.topic_id = ${topicAlias}.id
            ), '')
          )`;
}

export function validForumDiscussionCursor(value: string) {
  return Boolean(decodeForumDiscussionCursor(value));
}

export function encodeForumDiscussionCursor(cursor: ForumDiscussionCursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeForumDiscussionCursor(value: string): ForumDiscussionCursor | undefined {
  try {
    const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
    const lastActive = typeof parsed.lastActive === "string" ? parsed.lastActive.trim() : "";
    return id && lastActive ? { id, lastActive } : undefined;
  } catch {
    return undefined;
  }
}

export async function readCatalogDiscussionPage(
  db: D1Database,
  currentUser: CurrentUser,
  userColumns: UserProfileColumns,
  query: ForumDiscussionQuery = {}
): Promise<ForumDiscussionPage> {
  const limit = normalizeForumPageLimit(query.limit);
  const cursor = query.cursor ? decodeForumDiscussionCursor(query.cursor) : undefined;
  const filters = normalizeForumDiscussionQuery(query);
  const [pinnedIndex, regularIndex] = await Promise.all([
    cursor
      ? Promise.resolve({ results: [] } as Pick<D1Result<Record<string, unknown>>, "results">)
      : readForumTopicIndex(db, currentUser, filters, { limit: FORUM_PINNED_TOPIC_LIMIT, pinned: true }),
    readForumTopicIndex(db, currentUser, filters, { cursor, limit: limit + 1, pinned: false })
  ]);
  const pinnedRows = pinnedIndex.results ?? [];
  const regularRows = regularIndex.results ?? [];
  const hasMore = regularRows.length > limit;
  const pageRows = regularRows.slice(0, limit);
  const pinnedIds = pinnedRows.map((row) => readTopicIndexId(row)).filter(Boolean);
  const discussionIds = pageRows.map((row) => readTopicIndexId(row)).filter(Boolean);
  const topicIds = [...pinnedIds, ...discussionIds];
  const projected = topicIds.length > 0
    ? await readForumDiscussionProjection(db, currentUser, userColumns, topicIds)
    : [];
  const projectedById = new Map(projected.map((discussion) => [discussion.id, discussion]));
  const discussions = discussionIds
    .map((id) => projectedById.get(id))
    .filter((discussion): discussion is NonNullable<typeof discussion> => Boolean(discussion));
  const pinnedDiscussions = pinnedIds
    .map((id) => projectedById.get(id))
    .filter((discussion): discussion is NonNullable<typeof discussion> => Boolean(discussion));
  const lastRow = pageRows.at(-1);

  return {
    discussions,
    pinnedDiscussions,
    ...(hasMore && lastRow
      ? {
          nextCursor: encodeForumDiscussionCursor({
            id: readTopicIndexId(lastRow),
            lastActive: readTopicIndexLastActive(lastRow)
          })
        }
      : {})
  };
}

async function readForumDiscussionProjection(
  db: D1Database,
  currentUser: CurrentUser,
  userColumns: UserProfileColumns,
  topicIds: string[]
) {
  const [forumTopics, forumAttachments, forumLinks, forumPlugins, forumReplies, forumContributorAwards] = await Promise.all([
    readForumTopics(db, currentUser, userColumns, topicIds, { listProjection: true }),
    readForumListAttachments(db, topicIds),
    readForumListLinks(db, topicIds),
    readForumPlugins(db, topicIds, true),
    readLatestForumReplyPreviews(db, currentUser, userColumns, topicIds),
    readForumRootContributorAwards(db, topicIds)
  ]);

  return buildForumDiscussions(
    forumTopics.results ?? [],
    forumAttachments.results ?? [],
    forumLinks.results ?? [],
    forumPlugins.results ?? [],
    [],
    forumReplies.results ?? [],
    forumContributorAwards.results ?? []
  );
}

function readForumTopicIndex(
  db: D1Database,
  currentUser: CurrentUser,
  filters: ReturnType<typeof normalizeForumDiscussionQuery>,
  options: {
    cursor?: ForumDiscussionCursor;
    limit: number;
    pinned: boolean;
  }
) {
  const activityTimestamp = forumTopicActivityTimestampSql();
  const conditions = [
    "forum_topics.status = 'open'",
    "forum_topics.is_pinned = ?"
  ];
  const bindings: unknown[] = [options.pinned ? 1 : 0];

  if (filters.category) {
    conditions.push("forum_categories.slug = ?");
    bindings.push(filters.category);
  }
  if (filters.owner === "mine") {
    conditions.push("forum_topics.author_user_id = ?");
    bindings.push(currentUser.id);
  }
  if (filters.query) {
    const search = `%${escapeForumLikeValue(filters.query)}%`;
    conditions.push(`(
      forum_topics.title LIKE ? ESCAPE '\\'
      OR forum_topics.excerpt LIKE ? ESCAPE '\\'
      OR root_posts.body_markdown LIKE ? ESCAPE '\\'
      OR (forum_topics.is_anonymous != 1 AND users.name LIKE ? ESCAPE '\\')
      OR forum_categories.name LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1
        FROM forum_topic_tags AS search_tags
        WHERE search_tags.topic_id = forum_topics.id
          AND search_tags.tag LIKE ? ESCAPE '\\'
      )
    )`);
    bindings.push(search, search, search, search, search, search);
  }
  if (!options.pinned && options.cursor) {
    conditions.push(`(
      ${activityTimestamp} < ?
      OR (${activityTimestamp} = ? AND forum_topics.id < ?)
    )`);
    bindings.push(options.cursor.lastActive, options.cursor.lastActive, options.cursor.id);
  }

  const orderBy = options.pinned
    ? "forum_topics.pinned_at DESC, lastActive DESC, forum_topics.id DESC"
    : "lastActive DESC, forum_topics.id DESC";

  return db
    .prepare(
      `
      SELECT
        forum_topics.id,
        ${activityTimestamp} AS lastActive
      FROM forum_topics
      JOIN users ON users.id = forum_topics.author_user_id
      JOIN forum_categories ON forum_categories.id = forum_topics.category_id
      LEFT JOIN forum_posts AS root_posts ON root_posts.id = (
        SELECT root_post_lookup.id
        FROM forum_posts AS root_post_lookup
        WHERE root_post_lookup.topic_id = forum_topics.id
          AND root_post_lookup.parent_post_id IS NULL
        ORDER BY root_post_lookup.created_at ASC
        LIMIT 1
      )
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY ${orderBy}
      LIMIT ${Math.max(1, Math.floor(options.limit))}
      `
    )
    .bind(...bindings)
    .all<Record<string, unknown>>();
}

function normalizeForumDiscussionQuery(query: ForumDiscussionQuery) {
  const category = query.category?.trim().toLowerCase() ?? "";
  return {
    category: /^[a-z0-9][a-z0-9-]{0,63}$/.test(category) ? category : undefined,
    owner: query.owner === "mine" ? "mine" as const : "all" as const,
    query: query.query?.trim().slice(0, 160) || undefined
  };
}

function normalizeForumPageLimit(value: number | undefined) {
  const limit = Number.isFinite(value) ? Math.floor(Number(value)) : FORUM_TOPIC_DEFAULT_PAGE_LIMIT;
  return Math.min(FORUM_TOPIC_MAX_PAGE_LIMIT, Math.max(1, limit));
}

function escapeForumLikeValue(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function readTopicIndexId(row: Record<string, unknown>) {
  return typeof row.id === "string" ? row.id : String(row.id ?? "");
}

function readTopicIndexLastActive(row: Record<string, unknown>) {
  return typeof row.lastActive === "string" ? row.lastActive : String(row.lastActive ?? "");
}

export async function readCatalogDiscussions(db: D1Database, currentUser: CurrentUser, userColumns: UserProfileColumns) {
  const [forumTopics, forumAttachments, forumLinks, forumPlugins, forumMentions, forumReplies, forumContributorAwards] = await Promise.all([
    readForumTopics(db, currentUser, userColumns),
    readForumAttachments(db),
    readForumLinks(db),
    readForumPlugins(db),
    readForumMentions(db, userColumns),
    readForumReplies(db, currentUser, userColumns),
    readForumContributorAwards(db)
  ]);
  return buildForumDiscussions(
    forumTopics.results ?? [],
    forumAttachments.results ?? [],
    forumLinks.results ?? [],
    forumPlugins.results ?? [],
    forumMentions.results ?? [],
    forumReplies.results ?? [],
    forumContributorAwards.results ?? []
  );
}

export async function readCatalogDiscussion(
  db: D1Database,
  currentUser: CurrentUser,
  userColumns: UserProfileColumns,
  topicId: string
) {
  const [forumTopics, forumAttachments, forumLinks, forumPlugins, forumMentions, forumReplies, forumContributorAwards] = await Promise.all([
    readForumTopics(db, currentUser, userColumns, topicId),
    readForumAttachments(db, topicId),
    readForumLinks(db, topicId),
    readForumPlugins(db, topicId),
    readForumMentions(db, userColumns, topicId),
    readForumReplies(db, currentUser, userColumns, topicId),
    readForumContributorAwards(db, topicId)
  ]);
  const [discussion] = buildForumDiscussions(
    forumTopics.results ?? [],
    forumAttachments.results ?? [],
    forumLinks.results ?? [],
    forumPlugins.results ?? [],
    forumMentions.results ?? [],
    forumReplies.results ?? [],
    forumContributorAwards.results ?? []
  );

  return discussion;
}

function readForumTopics(
  db: D1Database,
  currentUser: CurrentUser,
  userColumns: UserProfileColumns,
  scope?: ForumTopicScope,
  options: { listProjection?: boolean } = {}
) {
  const topicIds = forumTopicScopeValues(scope);
  const listProjection = options.listProjection === true;
  const profileJoins = listProjection ? "" : `
      LEFT JOIN user_identity_profiles AS author_profiles ON author_profiles.user_id = users.id
      LEFT JOIN portal_user_journey_state AS author_journey ON author_journey.user_id = users.id`;
  const profileFields = listProjection
    ? `
        '' AS authorDepartment,
        '' AS authorJobTitle,
        '{}' AS authorProfileJson,
        '' AS authorJourneyLevelKey,
        NULL AS authorJourneyTotalPoints,
        NULL AS authorJourneyCommunityContributionPoints`
    : `
        CASE WHEN forum_topics.is_anonymous = 1 THEN '' ELSE author_profiles.department END AS authorDepartment,
        CASE WHEN forum_topics.is_anonymous = 1 THEN '' ELSE author_profiles.job_title END AS authorJobTitle,
        CASE WHEN forum_topics.is_anonymous = 1 THEN '{}' ELSE author_profiles.profile_json END AS authorProfileJson,
        CASE WHEN forum_topics.is_anonymous = 1 THEN '' ELSE author_journey.current_level_key END AS authorJourneyLevelKey,
        CASE WHEN forum_topics.is_anonymous = 1 THEN NULL ELSE author_journey.total_points END AS authorJourneyTotalPoints,
        CASE WHEN forum_topics.is_anonymous = 1 THEN NULL ELSE author_journey.community_contribution_points END AS authorJourneyCommunityContributionPoints`;
  const authorEmailField = listProjection
    ? "'' AS authorEmail"
    : "CASE WHEN forum_topics.is_anonymous = 1 THEN '' ELSE users.email END AS authorEmail";
  const likeFields = listProjection
    ? `0 AS likes, 0 AS likedByCurrentUser, '' AS currentUserReaction, '' AS reactionSummary`
    : `COUNT(DISTINCT forum_post_likes.user_id) AS likes,
        CASE WHEN viewer_topic_like.user_id IS NULL THEN 0 ELSE 1 END AS likedByCurrentUser,
        viewer_topic_like.reaction AS currentUserReaction,
        COALESCE((
          SELECT group_concat(reaction_rollup.reaction || ':' || reaction_rollup.reaction_count)
          FROM (
            SELECT COALESCE(reaction, 'thumbsup') AS reaction, COUNT(*) AS reaction_count
            FROM forum_post_likes
            WHERE post_id = root_posts.id
            GROUP BY COALESCE(reaction, 'thumbsup')
          ) AS reaction_rollup
        ), '') AS reactionSummary`;
  const likeJoins = listProjection ? "" : `
      LEFT JOIN forum_post_likes ON forum_post_likes.post_id = root_posts.id
      LEFT JOIN forum_post_likes AS viewer_topic_like ON viewer_topic_like.post_id = root_posts.id AND viewer_topic_like.user_id = ?`;
  const bindings = [currentUser.id, currentUser.id, ...(listProjection ? [] : [currentUser.id]), ...topicIds];
  return db
    .prepare(
      `
      SELECT
        forum_topics.id,
        root_posts.id AS rootPostId,
        forum_topics.title,
        CASE WHEN forum_topics.is_anonymous = 1 THEN '' ELSE users.id END AS authorId,
        CASE WHEN forum_topics.is_anonymous = 1 THEN 'Anonymous' ELSE users.name END AS author,
        ${authorEmailField},
        ${userColumns.avatarUrl ? "CASE WHEN forum_topics.is_anonymous = 1 THEN '' ELSE COALESCE(users.avatar_url, '') END" : "''"} AS authorAvatarUrl,
        CASE WHEN forum_topics.is_anonymous = 1 THEN '' ELSE author_teams.name END AS authorTeam,
        ${profileFields},
        forum_topics.is_anonymous AS anonymous,
        forum_topics.anonymous_persona AS anonymousPersona,
        CASE WHEN forum_topics.author_user_id = ? THEN 1 ELSE 0 END AS ownedByCurrentUser,
        (
          SELECT anonymous_posts.anonymous_persona
          FROM forum_posts AS anonymous_posts
          WHERE anonymous_posts.topic_id = forum_topics.id
            AND anonymous_posts.author_user_id = ?
            AND anonymous_posts.is_anonymous = 1
            AND anonymous_posts.anonymous_persona IS NOT NULL
          ORDER BY anonymous_posts.created_at ASC
          LIMIT 1
        ) AS currentUserAnonymousPersona,
        substr(users.name, 1, 1) || substr(COALESCE(NULLIF(substr(users.name, instr(users.name, ' ') + 1), users.name), users.name), 1, 1) AS authorAvatar,
        forum_categories.name AS category,
        forum_categories.slug AS categorySlug,
        forum_topics.topic_type AS topicType,
        forum_topics.source AS source,
        forum_topics.is_pinned AS pinned,
        topic_teams.name AS bu,
        forum_topics.excerpt,
        forum_topics.reply_count AS replies,
        forum_topics.view_count AS views,
        ${likeFields},
        ${forumTopicActivityTimestampSql()} AS lastActive,
        skills.name AS linkedSkill,
        apps.name AS linkedApp,
        mcp_servers.name AS linkedMcp,
        COALESCE(group_concat(DISTINCT forum_topic_tags.tag), '') AS tags,
        root_posts.created_at AS createdAt,
        root_posts.updated_at AS updatedAt,
        ${listProjection ? "''" : "root_posts.body_markdown"} AS body
      FROM forum_topics
      JOIN users ON users.id = forum_topics.author_user_id
      JOIN forum_categories ON forum_categories.id = forum_topics.category_id
      LEFT JOIN forum_posts AS root_posts ON root_posts.id = (
        SELECT root_post_lookup.id
        FROM forum_posts AS root_post_lookup
        WHERE root_post_lookup.topic_id = forum_topics.id
          AND root_post_lookup.parent_post_id IS NULL
        ORDER BY root_post_lookup.created_at ASC
        LIMIT 1
      )
      LEFT JOIN teams AS topic_teams ON topic_teams.id = forum_topics.bu_team_id
      LEFT JOIN teams AS author_teams ON author_teams.id = users.team_id
      ${profileJoins}
      LEFT JOIN skills ON skills.id = forum_topics.linked_skill_id
      LEFT JOIN apps ON apps.id = forum_topics.linked_app_id
      LEFT JOIN mcp_servers ON mcp_servers.id = forum_topics.linked_mcp_server_id
      LEFT JOIN forum_topic_tags ON forum_topic_tags.topic_id = forum_topics.id
      ${likeJoins}
      WHERE forum_topics.status = 'open'
      ${topicIds.length > 0 ? `AND forum_topics.id IN (${forumTopicPlaceholders(topicIds)})` : ""}
      GROUP BY forum_topics.id
      ORDER BY forum_topics.is_pinned DESC, forum_topics.pinned_at DESC, lastActive DESC, forum_topics.id DESC
      LIMIT ${topicIds.length > 0 ? topicIds.length : CATALOG_FORUM_TOPIC_LIMIT}
      `
    )
    .bind(...bindings)
    .all();
}

function readForumListAttachments(db: D1Database, scope: ForumTopicScope) {
  const statement = db.prepare(
    `
    SELECT
      forum_attachments.id,
      forum_attachments.topic_id AS topicId,
      forum_attachments.post_id AS postId,
      forum_attachments.public_url AS url,
      forum_attachments.mime_type AS mimeType,
      forum_attachments.file_name AS fileName,
      forum_attachments.file_size AS fileSize,
      forum_attachments.display_order AS displayOrder
    FROM forum_attachments
    WHERE forum_attachments.topic_id IN (${forumTopicIdsSql(scope)})
      AND forum_attachments.id = (
        SELECT preview_attachment.id
        FROM forum_attachments AS preview_attachment
        WHERE preview_attachment.topic_id = forum_attachments.topic_id
          AND (
            preview_attachment.post_id IS NULL
            OR preview_attachment.post_id = (
              SELECT root_post.id
              FROM forum_posts AS root_post
              WHERE root_post.topic_id = preview_attachment.topic_id
                AND root_post.parent_post_id IS NULL
              ORDER BY root_post.created_at ASC
              LIMIT 1
            )
          )
        ORDER BY
          CASE WHEN lower(preview_attachment.mime_type) LIKE 'image/%' THEN 0 ELSE 1 END,
          preview_attachment.display_order,
          preview_attachment.created_at
        LIMIT 1
      )
    ORDER BY forum_attachments.topic_id
    `
  );
  return bindForumTopicScope(statement, scope).all();
}

function readForumAttachments(db: D1Database, scope?: ForumTopicScope) {
  const statement = db
    .prepare(
      `
      SELECT
        id,
        topic_id AS topicId,
        post_id AS postId,
        public_url AS url,
        mime_type AS mimeType,
        file_name AS fileName,
        file_size AS fileSize,
        display_order AS displayOrder
      FROM forum_attachments
      WHERE topic_id IN (${forumTopicIdsSql(scope)})
      ORDER BY topic_id, display_order, created_at
      `
    );

  return bindForumTopicScope(statement, scope).all();
}

function readForumRootContributorAwards(db: D1Database, scope: ForumTopicScope) {
  const statement = db.prepare(
    `
    SELECT
      forum_contributor_awards.id,
      forum_contributor_awards.topic_id AS topicId,
      forum_contributor_awards.post_id AS postId,
      forum_contributor_awards.awarded_by_user_id AS awardedByUserId,
      COALESCE(award_admin.name, '') AS awardedByName,
      forum_contributor_awards.points,
      forum_contributor_awards.note,
      forum_contributor_awards.created_at AS createdAt
    FROM forum_contributor_awards
    LEFT JOIN users AS award_admin ON award_admin.id = forum_contributor_awards.awarded_by_user_id
    WHERE forum_contributor_awards.topic_id IN (${forumTopicIdsSql(scope)})
      AND forum_contributor_awards.post_id = (
        SELECT root_post.id
        FROM forum_posts AS root_post
        WHERE root_post.topic_id = forum_contributor_awards.topic_id
          AND root_post.parent_post_id IS NULL
        ORDER BY root_post.created_at ASC
        LIMIT 1
      )
    ORDER BY forum_contributor_awards.topic_id
    `
  );
  return bindForumTopicScope(statement, scope).all();
}

function readForumListLinks(db: D1Database, scope: ForumTopicScope) {
  const statement = db.prepare(
    `
    SELECT
      forum_link_embeds.id,
      forum_link_embeds.topic_id AS topicId,
      forum_link_embeds.url,
      forum_link_embeds.provider,
      forum_link_embeds.title,
      '' AS description,
      forum_link_embeds.preview_image_url AS previewImageUrl,
      forum_link_embeds.embed_type AS embedType
    FROM forum_link_embeds
    WHERE forum_link_embeds.topic_id IN (${forumTopicIdsSql(scope)})
      AND forum_link_embeds.id = (
        SELECT preview_link.id
        FROM forum_link_embeds AS preview_link
        WHERE preview_link.topic_id = forum_link_embeds.topic_id
          AND (
            preview_link.post_id IS NULL
            OR preview_link.post_id = (
              SELECT root_post.id
              FROM forum_posts AS root_post
              WHERE root_post.topic_id = preview_link.topic_id
                AND root_post.parent_post_id IS NULL
              ORDER BY root_post.created_at ASC
              LIMIT 1
            )
          )
        ORDER BY
          CASE WHEN COALESCE(preview_link.preview_image_url, '') = '' THEN 1 ELSE 0 END,
          preview_link.created_at
        LIMIT 1
      )
    ORDER BY forum_link_embeds.topic_id
    `
  );
  return bindForumTopicScope(statement, scope).all();
}

function readForumContributorAwards(db: D1Database, scope?: ForumTopicScope) {
  const statement = db
    .prepare(
      `
      SELECT
        forum_contributor_awards.id,
        forum_contributor_awards.topic_id AS topicId,
        forum_contributor_awards.post_id AS postId,
        forum_contributor_awards.awarded_by_user_id AS awardedByUserId,
        COALESCE(award_admin.name, '') AS awardedByName,
        forum_contributor_awards.points,
        forum_contributor_awards.note,
        forum_contributor_awards.created_at AS createdAt
      FROM forum_contributor_awards
      LEFT JOIN users AS award_admin ON award_admin.id = forum_contributor_awards.awarded_by_user_id
      WHERE forum_contributor_awards.topic_id IN (${forumTopicIdsSql(scope)})
      ORDER BY forum_contributor_awards.topic_id, forum_contributor_awards.created_at
      `
    );

  return bindForumTopicScope(statement, scope).all();
}

function readForumLinks(db: D1Database, scope?: ForumTopicScope) {
  const statement = db
    .prepare(
      `
      SELECT
        id,
        topic_id AS topicId,
        url,
        provider,
        title,
        description,
        preview_image_url AS previewImageUrl,
        embed_type AS embedType
      FROM forum_link_embeds
      WHERE topic_id IN (${forumTopicIdsSql(scope)})
      ORDER BY topic_id, created_at
      `
    );

  return bindForumTopicScope(statement, scope).all();
}

function readForumPlugins(db: D1Database, scope?: ForumTopicScope, listProjection = false) {
  const statement = db
    .prepare(
      `
      SELECT
        forum_content_plugins.id,
        forum_content_plugins.topic_id AS topicId,
        forum_content_plugins.plugin_type AS pluginType,
        forum_content_plugins.target_type AS targetType,
        forum_content_plugins.target_id AS targetId,
        forum_content_plugins.config_json AS configJson,
        COALESCE(publication_listings.name, apps.name, skills.name, mcp_servers.name, forum_content_plugins.target_id) AS title,
        ${listProjection ? "''" : "COALESCE(publication_listings.summary, publication_listings.description, apps.description, skills.description, mcp_servers.endpoint_url, '')"} AS description,
        ${listProjection ? "''" : "COALESCE(publication_publishers.name, publication_publishers.email, app_owner_teams.name, skill_owner_teams.name, mcp_owner_teams.name, '')"} AS owner,
        ${listProjection ? "''" : "COALESCE(publication_categories.name, app_categories.name, skill_meta_categories.name, '')"} AS category,
        COALESCE(publication_listings.cover_image_url, app_catalog_metadata.cover_image_url, skill_catalog_metadata.cover_image_url, '') AS iconUrl,
        ${listProjection ? "0" : "COALESCE(publication_listings.install_count, app_catalog_metadata.launch_count, skill_catalog_metadata.install_count, 0)"} AS installs,
        ${listProjection ? "''" : "COALESCE(publication_listings.effective_status, apps.status, skills.status, mcp_servers.status, '')"} AS status
      FROM forum_content_plugins
      LEFT JOIN publication_listings ON forum_content_plugins.target_type = publication_listings.listing_type AND forum_content_plugins.target_id = publication_listings.target_id
      LEFT JOIN users AS publication_publishers ON publication_publishers.id = publication_listings.created_by_user_id
      LEFT JOIN skill_categories AS publication_categories ON publication_categories.id = publication_listings.category_id
      LEFT JOIN apps ON forum_content_plugins.target_type = 'app' AND apps.id = forum_content_plugins.target_id
      LEFT JOIN teams AS app_owner_teams ON app_owner_teams.id = apps.owner_team_id
      LEFT JOIN app_catalog_metadata ON app_catalog_metadata.app_id = apps.id
      LEFT JOIN skill_categories AS app_categories ON app_categories.id = app_catalog_metadata.category_id
      LEFT JOIN skills ON forum_content_plugins.target_type = 'skill' AND skills.id = forum_content_plugins.target_id
      LEFT JOIN teams AS skill_owner_teams ON skill_owner_teams.id = skills.owner_team_id
      LEFT JOIN skill_catalog_metadata ON skill_catalog_metadata.skill_id = skills.id
      LEFT JOIN skill_categories AS skill_meta_categories ON skill_meta_categories.id = skill_catalog_metadata.category_id
      LEFT JOIN mcp_servers ON forum_content_plugins.target_type = 'mcp' AND mcp_servers.id = forum_content_plugins.target_id
      LEFT JOIN teams AS mcp_owner_teams ON mcp_owner_teams.id = mcp_servers.owner_team_id
      WHERE forum_content_plugins.topic_id IN (${forumTopicIdsSql(scope)})
        ${listProjection ? `AND forum_content_plugins.id = (
          SELECT preview_plugin.id
          FROM forum_content_plugins AS preview_plugin
          WHERE preview_plugin.topic_id = forum_content_plugins.topic_id
            AND (
              preview_plugin.post_id IS NULL
              OR preview_plugin.post_id = (
                SELECT root_post.id
                FROM forum_posts AS root_post
                WHERE root_post.topic_id = preview_plugin.topic_id
                  AND root_post.parent_post_id IS NULL
                ORDER BY root_post.created_at ASC
                LIMIT 1
              )
            )
          ORDER BY preview_plugin.created_at
          LIMIT 1
        )` : ""}
      ORDER BY forum_content_plugins.topic_id, forum_content_plugins.created_at
      `
    );

  return bindForumTopicScope(statement, scope).all();
}

function readLatestForumReplyPreviews(
  db: D1Database,
  currentUser: CurrentUser,
  userColumns: UserProfileColumns,
  scope: ForumTopicScope
) {
  const statement = db.prepare(
    `
    WITH ranked_replies AS (
      SELECT
        forum_posts.id,
        forum_posts.topic_id AS topicId,
        ROW_NUMBER() OVER (
          PARTITION BY forum_posts.topic_id
          ORDER BY forum_posts.created_at DESC, forum_posts.id DESC
        ) AS replyRank
      FROM forum_posts
      WHERE forum_posts.topic_id IN (${forumTopicIdsSql(scope)})
        AND forum_posts.id NOT IN (
          SELECT root_posts.id
          FROM forum_posts AS root_posts
          WHERE root_posts.topic_id = forum_posts.topic_id
            AND root_posts.parent_post_id IS NULL
          ORDER BY root_posts.created_at ASC
          LIMIT 1
        )
    )
    SELECT
      forum_posts.id,
      forum_posts.topic_id AS topicId,
      CASE WHEN forum_posts.is_anonymous = 1 THEN '' ELSE users.id END AS authorId,
      CASE WHEN forum_posts.is_anonymous = 1 THEN 'Anonymous' ELSE users.name END AS author,
      '' AS authorEmail,
      ${userColumns.avatarUrl ? "COALESCE(users.avatar_url, '')" : "''"} AS authorAvatarUrl,
      author_teams.name AS authorTeam,
      forum_posts.is_anonymous AS anonymous,
      forum_posts.anonymous_persona AS anonymousPersona,
      CASE WHEN forum_posts.author_user_id = ? THEN 1 ELSE 0 END AS ownedByCurrentUser,
      substr(forum_posts.body_markdown, 1, 600) AS body,
      forum_posts.created_at AS createdAt,
      forum_posts.parent_post_id AS parentPostId
    FROM ranked_replies
    JOIN forum_posts ON forum_posts.id = ranked_replies.id
    JOIN users ON users.id = forum_posts.author_user_id
    LEFT JOIN teams AS author_teams ON author_teams.id = users.team_id
    WHERE ranked_replies.replyRank = 1
    ORDER BY forum_posts.topic_id
    `
  );

  return statement.bind(...forumTopicScopeValues(scope), currentUser.id).all();
}

function readForumMentions(db: D1Database, userColumns: UserProfileColumns, scope?: ForumTopicScope) {
  const statement = db
    .prepare(
      `
      SELECT
        forum_mentions.id,
        forum_mentions.topic_id AS topicId,
        forum_mentions.post_id AS postId,
        forum_mentions.mentioned_user_id AS userId,
        forum_mentions.mention_text AS text,
        COALESCE(users.name, forum_mentions.mention_text) AS name,
        users.email,
        ${userColumns.avatarUrl ? "COALESCE(users.avatar_url, '')" : "''"} AS avatarUrl,
        mentioned_teams.name AS team,
        mentioned_profiles.department,
        mentioned_profiles.job_title AS jobTitle,
        mentioned_profiles.profile_json AS profileJson,
        mentioned_journey.current_level_key AS journeyLevelKey,
        mentioned_journey.total_points AS journeyTotalPoints,
        mentioned_journey.community_contribution_points AS journeyCommunityContributionPoints,
        COALESCE(substr(users.email, 1, instr(users.email, '@') - 1), replace(forum_mentions.mention_text, '@', '')) AS emailPrefix
      FROM forum_mentions
      LEFT JOIN users ON users.id = forum_mentions.mentioned_user_id
      LEFT JOIN teams AS mentioned_teams ON mentioned_teams.id = users.team_id
      LEFT JOIN user_identity_profiles AS mentioned_profiles ON mentioned_profiles.user_id = users.id
      LEFT JOIN portal_user_journey_state AS mentioned_journey ON mentioned_journey.user_id = users.id
      WHERE forum_mentions.topic_id IN (${forumTopicIdsSql(scope)})
      ORDER BY forum_mentions.topic_id, forum_mentions.created_at
      `
    );

  return bindForumTopicScope(statement, scope).all();
}

function readForumReplies(db: D1Database, currentUser: CurrentUser, userColumns: UserProfileColumns, scope?: ForumTopicScope) {
  return db
    .prepare(
      `
      SELECT
        forum_posts.id,
        forum_posts.topic_id AS topicId,
        CASE WHEN forum_posts.is_anonymous = 1 THEN '' ELSE users.id END AS authorId,
        CASE WHEN forum_posts.is_anonymous = 1 THEN 'Anonymous' ELSE users.name END AS author,
        CASE WHEN forum_posts.is_anonymous = 1 THEN '' ELSE users.email END AS authorEmail,
        ${userColumns.avatarUrl ? "CASE WHEN forum_posts.is_anonymous = 1 THEN '' ELSE COALESCE(users.avatar_url, '') END" : "''"} AS authorAvatarUrl,
        CASE WHEN forum_posts.is_anonymous = 1 THEN '' ELSE author_teams.name END AS authorTeam,
        CASE WHEN forum_posts.is_anonymous = 1 THEN '' ELSE author_profiles.department END AS authorDepartment,
        CASE WHEN forum_posts.is_anonymous = 1 THEN '' ELSE author_profiles.job_title END AS authorJobTitle,
        CASE WHEN forum_posts.is_anonymous = 1 THEN '{}' ELSE author_profiles.profile_json END AS authorProfileJson,
        CASE WHEN forum_posts.is_anonymous = 1 THEN '' ELSE author_journey.current_level_key END AS authorJourneyLevelKey,
        CASE WHEN forum_posts.is_anonymous = 1 THEN NULL ELSE author_journey.total_points END AS authorJourneyTotalPoints,
        CASE WHEN forum_posts.is_anonymous = 1 THEN NULL ELSE author_journey.community_contribution_points END AS authorJourneyCommunityContributionPoints,
        forum_posts.is_anonymous AS anonymous,
        forum_posts.anonymous_persona AS anonymousPersona,
        CASE WHEN forum_posts.author_user_id = ? THEN 1 ELSE 0 END AS ownedByCurrentUser,
        forum_posts.body_markdown AS body,
        forum_posts.source AS source,
        forum_posts.is_pinned AS pinned,
        forum_posts.parent_post_id AS parentPostId,
        forum_posts.created_at AS createdAt,
        forum_posts.updated_at AS updatedAt,
        COUNT(DISTINCT reply_likes.user_id) AS likes,
        CASE WHEN viewer_reply_like.user_id IS NULL THEN 0 ELSE 1 END AS likedByCurrentUser,
        viewer_reply_like.reaction AS currentUserReaction,
        COALESCE((
          SELECT group_concat(reaction_rollup.reaction || ':' || reaction_rollup.reaction_count)
          FROM (
            SELECT COALESCE(reaction, 'thumbsup') AS reaction, COUNT(*) AS reaction_count
            FROM forum_post_likes
            WHERE post_id = forum_posts.id
            GROUP BY COALESCE(reaction, 'thumbsup')
          ) AS reaction_rollup
        ), '') AS reactionSummary
      FROM forum_posts
      JOIN users ON users.id = forum_posts.author_user_id
      LEFT JOIN teams AS author_teams ON author_teams.id = users.team_id
      LEFT JOIN user_identity_profiles AS author_profiles ON author_profiles.user_id = users.id
      LEFT JOIN portal_user_journey_state AS author_journey ON author_journey.user_id = users.id
      LEFT JOIN forum_post_likes AS reply_likes ON reply_likes.post_id = forum_posts.id
      LEFT JOIN forum_post_likes AS viewer_reply_like ON viewer_reply_like.post_id = forum_posts.id AND viewer_reply_like.user_id = ?
      WHERE forum_posts.topic_id IN (${forumTopicIdsSql(scope)})
        AND forum_posts.id NOT IN (
        SELECT root_posts.id
        FROM forum_posts AS root_posts
        WHERE root_posts.topic_id = forum_posts.topic_id
          AND root_posts.parent_post_id IS NULL
        ORDER BY root_posts.created_at ASC
        LIMIT 1
      )
      GROUP BY forum_posts.id
      ORDER BY forum_posts.topic_id, forum_posts.is_pinned DESC, forum_posts.pinned_at DESC, forum_posts.created_at ASC
      `
    )
    .bind(currentUser.id, currentUser.id, ...forumTopicScopeValues(scope))
    .all();
}

function forumTopicIdsSql(scope?: ForumTopicScope) {
  const topicIds = forumTopicScopeValues(scope);
  if (topicIds.length > 0) {
    return `
          SELECT id
          FROM forum_topics
          WHERE id IN (${forumTopicPlaceholders(topicIds)})
            AND status = 'open'
        `;
  }

  return selectedForumTopicIdsSql();
}

function forumTopicScopeValues(scope?: ForumTopicScope) {
  return Array.isArray(scope) ? scope : scope ? [scope] : [];
}

function forumTopicPlaceholders(topicIds: string[]) {
  return topicIds.map(() => "?").join(", ");
}

function bindForumTopicScope(statement: D1PreparedStatement, scope?: ForumTopicScope) {
  const topicIds = forumTopicScopeValues(scope);
  return topicIds.length > 0 ? statement.bind(...topicIds) : statement;
}
