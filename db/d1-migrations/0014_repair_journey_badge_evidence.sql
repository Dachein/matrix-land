-- Repair Journey evidence that drifted from the current Forum, Publication,
-- and MCP connection models. Every insert is idempotent so the historical
-- compensation is safe to rehearse and retry.

-- An authorized Workspace MCP MCP connection is a durable declaration of the
-- Agent the user works with. Include explicit Journey preferences and older
-- MCP audit evidence so inactive historical connections are compensated too.
WITH agent_evidence AS (
  SELECT portal_user_journey_state.user_id
  FROM portal_user_journey_state
  WHERE json_valid(portal_user_journey_state.profile_json)
    AND json_extract(portal_user_journey_state.profile_json, '$.agentPreference')
      IN ('workbuddy', 'codex', 'claude-code', 'cursor')

  UNION

  SELECT portal_user_badges.user_id
  FROM portal_user_badges
  WHERE portal_user_badges.badge_key = 'mcp_connected'

  UNION

  SELECT audit_logs.actor_id
  FROM audit_logs
  WHERE audit_logs.actor_type = 'user'
    AND json_valid(audit_logs.metadata_json)
    AND json_extract(audit_logs.metadata_json, '$.agentType')
      IN ('workbuddy', 'codex', 'claude-code', 'cursor')
)
INSERT OR IGNORE INTO portal_user_badges (
  user_id,
  badge_key,
  source,
  source_event_id,
  metadata_json
)
SELECT
  agent_evidence.user_id,
  'agent_declared',
  'computed',
  NULL,
  json_object(
    'historicalBackfill', json('true'),
    'evidence', 'mcp_connection_or_profile'
  )
FROM agent_evidence
JOIN users ON users.id = agent_evidence.user_id
WHERE users.status != 'deleted';

-- A Forum reply is every post after the canonical first/root post in a topic.
-- parent_post_id describes reply nesting and is NULL for ordinary top-level
-- replies, so it must not be used to distinguish a topic body from a reply.
WITH forum_replies AS (
  SELECT
    forum_posts.id,
    forum_posts.author_user_id,
    forum_posts.created_at,
    forum_topics.title,
    ROW_NUMBER() OVER (
      PARTITION BY forum_posts.author_user_id
      ORDER BY forum_posts.created_at ASC, forum_posts.id ASC
    ) AS reply_rank
  FROM forum_posts
  JOIN forum_topics ON forum_topics.id = forum_posts.topic_id
  WHERE forum_topics.status != 'archived'
    AND forum_posts.id <> (
      SELECT root_post.id
      FROM forum_posts AS root_post
      WHERE root_post.topic_id = forum_posts.topic_id
      ORDER BY root_post.created_at ASC, root_post.id ASC
      LIMIT 1
    )
)
INSERT OR IGNORE INTO portal_user_badges (
  user_id,
  badge_key,
  source,
  source_event_id,
  metadata_json,
  awarded_at
)
SELECT
  forum_replies.author_user_id,
  'first_reply',
  'forum',
  forum_replies.id,
  json_object(
    'historicalBackfill', json('true'),
    'topicTitle', forum_replies.title
  ),
  forum_replies.created_at
FROM forum_replies
JOIN users ON users.id = forum_replies.author_user_id
WHERE forum_replies.reply_rank = 1
  AND users.status != 'deleted';

-- The Portal now records app.visit_url. Keep the legacy direct-jump event for
-- older launches while awarding every user with either form of evidence.
WITH app_launches AS (
  SELECT
    audit_logs.id,
    audit_logs.actor_id,
    audit_logs.action,
    audit_logs.created_at,
    ROW_NUMBER() OVER (
      PARTITION BY audit_logs.actor_id
      ORDER BY audit_logs.created_at ASC, audit_logs.id ASC
    ) AS launch_rank
  FROM audit_logs
  WHERE audit_logs.actor_type = 'user'
    AND audit_logs.action IN ('issued direct jump token', 'app.visit_url')
)
INSERT OR IGNORE INTO portal_user_badges (
  user_id,
  badge_key,
  source,
  source_event_id,
  metadata_json,
  awarded_at
)
SELECT
  app_launches.actor_id,
  'first_app_launch',
  'audit',
  app_launches.id,
  json_object(
    'historicalBackfill', json('true'),
    'action', app_launches.action
  ),
  app_launches.created_at
FROM app_launches
JOIN users ON users.id = app_launches.actor_id
WHERE app_launches.launch_rank = 1
  AND users.status != 'deleted';

-- App launch repair also unlocks Workflow Explorer for existing APPS Skill
-- users. Both prerequisite badges are durable historical evidence.
INSERT OR IGNORE INTO portal_user_badges (
  user_id,
  badge_key,
  source,
  source_event_id,
  metadata_json
)
SELECT
  app_launch.user_id,
  'workflow_explorer',
  'computed',
  NULL,
  json_object(
    'historicalBackfill', json('true'),
    'surfaces', 2
  )
FROM portal_user_badges AS app_launch
JOIN portal_user_badges AS apps_skill
  ON apps_skill.user_id = app_launch.user_id
 AND apps_skill.badge_key = 'apps_skill_user'
JOIN users ON users.id = app_launch.user_id
WHERE app_launch.badge_key = 'first_app_launch'
  AND users.status != 'deleted';

-- Team reuse must include current Publication app visits as well as the
-- compatibility-only direct-jump event. Portal listing ownership is the
-- available historical owner projection for this one-time compensation.
WITH project_usage AS (
  SELECT
    publication_listings.id AS project_id,
    publication_installations.user_id
  FROM publication_listings
  JOIN publication_installations
    ON publication_installations.listing_id = publication_listings.id
  WHERE publication_listings.target_plane = 'apps'
    AND publication_listings.effective_status = 'listed'
    AND publication_installations.install_type != 'bookmark'
    AND publication_installations.user_id != publication_listings.created_by_user_id

  UNION

  SELECT
    publication_listings.id AS project_id,
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
    AND audit_logs.actor_id != publication_listings.created_by_user_id
), reused_projects AS (
  SELECT
    publication_listings.created_by_user_id AS user_id,
    COUNT(DISTINCT project_usage.project_id) AS reused_projects
  FROM project_usage
  JOIN publication_listings ON publication_listings.id = project_usage.project_id
  GROUP BY publication_listings.created_by_user_id, project_usage.project_id
  HAVING COUNT(DISTINCT project_usage.user_id) >= 5
), reused_owners AS (
  SELECT user_id, SUM(reused_projects) AS reused_projects
  FROM reused_projects
  GROUP BY user_id
)
INSERT OR IGNORE INTO portal_user_badges (
  user_id,
  badge_key,
  source,
  source_event_id,
  metadata_json
)
SELECT
  reused_owners.user_id,
  'reused_by_team',
  'market',
  NULL,
  json_object(
    'historicalBackfill', json('true'),
    'reusedAppss', reused_owners.reused_projects,
    'distinctUsersRequired', 5
  )
FROM reused_owners
JOIN users ON users.id = reused_owners.user_id
WHERE users.status != 'deleted';

-- Rebuild every persisted Journey projection after awarding the repaired
-- badges. Community reply points use the same canonical root-post rule.
INSERT OR IGNORE INTO portal_user_journey_state (user_id)
SELECT users.id
FROM users
WHERE users.status != 'deleted';

WITH badge_totals AS (
  SELECT
    portal_user_badges.user_id,
    COUNT(*) AS badge_count,
    COALESCE(SUM(portal_badge_definitions.points), 0) AS badge_points,
    SUM(CASE WHEN portal_badge_definitions.category = 'foundation' THEN 1 ELSE 0 END) AS foundation_count,
    SUM(CASE WHEN portal_badge_definitions.category = 'community' THEN 1 ELSE 0 END) AS community_count,
    SUM(CASE WHEN portal_badge_definitions.category = 'usage' THEN 1 ELSE 0 END) AS usage_count,
    SUM(CASE WHEN portal_badge_definitions.category = 'builder' THEN 1 ELSE 0 END) AS builder_count,
    SUM(CASE WHEN portal_badge_definitions.category = 'impact' THEN 1 ELSE 0 END) AS impact_count
  FROM portal_user_badges
  JOIN portal_badge_definitions
    ON portal_badge_definitions.badge_key = portal_user_badges.badge_key
   AND portal_badge_definitions.active = 1
  GROUP BY portal_user_badges.user_id
), community_events AS (
  SELECT author_user_id AS user_id, COUNT(*) * 5 AS points
  FROM forum_topics
  WHERE status != 'archived'
  GROUP BY author_user_id

  UNION ALL

  SELECT forum_posts.author_user_id AS user_id, COUNT(*) AS points
  FROM forum_posts
  JOIN forum_topics ON forum_topics.id = forum_posts.topic_id
  WHERE forum_topics.status != 'archived'
    AND forum_posts.id <> (
      SELECT root_post.id
      FROM forum_posts AS root_post
      WHERE root_post.topic_id = forum_posts.topic_id
      ORDER BY root_post.created_at ASC, root_post.id ASC
      LIMIT 1
    )
  GROUP BY forum_posts.author_user_id

  UNION ALL

  SELECT recipient_user_id AS user_id, COALESCE(SUM(points), 0) AS points
  FROM forum_contributor_awards
  GROUP BY recipient_user_id
), community_totals AS (
  SELECT user_id, SUM(points) AS points
  FROM community_events
  GROUP BY user_id
)
UPDATE portal_user_journey_state
SET
  community_contribution_points = COALESCE((
    SELECT community_totals.points
    FROM community_totals
    WHERE community_totals.user_id = portal_user_journey_state.user_id
  ), 0),
  total_points = COALESCE((
    SELECT badge_totals.badge_points
    FROM badge_totals
    WHERE badge_totals.user_id = portal_user_journey_state.user_id
  ), 0) + COALESCE((
    SELECT community_totals.points
    FROM community_totals
    WHERE community_totals.user_id = portal_user_journey_state.user_id
  ), 0),
  badge_count = COALESCE((
    SELECT badge_totals.badge_count
    FROM badge_totals
    WHERE badge_totals.user_id = portal_user_journey_state.user_id
  ), 0),
  category_counts_json = json_object(
    'foundation', COALESCE((SELECT foundation_count FROM badge_totals WHERE badge_totals.user_id = portal_user_journey_state.user_id), 0),
    'community', COALESCE((SELECT community_count FROM badge_totals WHERE badge_totals.user_id = portal_user_journey_state.user_id), 0),
    'usage', COALESCE((SELECT usage_count FROM badge_totals WHERE badge_totals.user_id = portal_user_journey_state.user_id), 0),
    'builder', COALESCE((SELECT builder_count FROM badge_totals WHERE badge_totals.user_id = portal_user_journey_state.user_id), 0),
    'impact', COALESCE((SELECT impact_count FROM badge_totals WHERE badge_totals.user_id = portal_user_journey_state.user_id), 0)
  ),
  recomputed_at = CURRENT_TIMESTAMP,
  updated_at = CURRENT_TIMESTAMP;

UPDATE portal_user_journey_state
SET
  current_level_key = CASE
    WHEN total_points >= 700
      AND EXISTS (
        SELECT 1
        FROM portal_user_badges
        JOIN portal_badge_definitions
          ON portal_badge_definitions.badge_key = portal_user_badges.badge_key
         AND portal_badge_definitions.active = 1
        WHERE portal_user_badges.user_id = portal_user_journey_state.user_id
          AND portal_badge_definitions.category = 'impact'
      )
      AND EXISTS (
        SELECT 1 FROM portal_user_badges
        WHERE portal_user_badges.user_id = portal_user_journey_state.user_id
          AND portal_user_badges.badge_key = 'first_published_capability'
      )
      THEN 'master'
    WHEN total_points >= 500
      AND EXISTS (
        SELECT 1
        FROM portal_user_badges
        JOIN portal_badge_definitions
          ON portal_badge_definitions.badge_key = portal_user_badges.badge_key
         AND portal_badge_definitions.active = 1
        WHERE portal_user_badges.user_id = portal_user_journey_state.user_id
          AND portal_badge_definitions.category = 'builder'
      )
      AND EXISTS (
        SELECT 1 FROM portal_user_badges
        WHERE portal_user_badges.user_id = portal_user_journey_state.user_id
          AND portal_user_badges.badge_key = 'first_published_capability'
      )
      THEN 'builder'
    WHEN total_points >= 150
      AND EXISTS (
        SELECT 1
        FROM portal_user_badges
        JOIN portal_badge_definitions
          ON portal_badge_definitions.badge_key = portal_user_badges.badge_key
         AND portal_badge_definitions.active = 1
        WHERE portal_user_badges.user_id = portal_user_journey_state.user_id
          AND portal_badge_definitions.category IN ('community', 'usage')
      )
      THEN 'contributor'
    WHEN total_points >= 100
      AND 2 <= (
        SELECT COUNT(*)
        FROM portal_user_badges
        JOIN portal_badge_definitions
          ON portal_badge_definitions.badge_key = portal_user_badges.badge_key
         AND portal_badge_definitions.active = 1
        WHERE portal_user_badges.user_id = portal_user_journey_state.user_id
          AND portal_badge_definitions.category = 'foundation'
      )
      THEN 'explorer'
    ELSE 'newcomer'
  END,
  next_badges_json = COALESCE((
    SELECT json_group_array(next_badge.badge_key)
    FROM (
      SELECT portal_badge_definitions.badge_key
      FROM portal_badge_definitions
      WHERE portal_badge_definitions.active = 1
        AND NOT EXISTS (
          SELECT 1
          FROM portal_user_badges
          WHERE portal_user_badges.user_id = portal_user_journey_state.user_id
            AND portal_user_badges.badge_key = portal_badge_definitions.badge_key
        )
      ORDER BY portal_badge_definitions.sort_order
      LIMIT 4
    ) AS next_badge
  ), '[]'),
  updated_at = CURRENT_TIMESTAMP;
