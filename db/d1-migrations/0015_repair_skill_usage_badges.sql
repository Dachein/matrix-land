-- Complete the historical Publication usage compensation after 0014. The
-- first repair covered Forum/app/MCP evidence, but it did not materialize
-- Publication Skill installation evidence into the corresponding Journey
-- badges. Keep this migration idempotent so it is safe to rehearse/retry.

-- Any Publication Skill installation satisfies first_skill_install, matching
-- the live evaluator (including legacy download/bookmark installation rows).
WITH skill_installs AS (
  SELECT
    publication_installations.id,
    publication_installations.user_id,
    publication_installations.created_at,
    COUNT(*) OVER (PARTITION BY publication_installations.user_id) AS installs,
    ROW_NUMBER() OVER (
      PARTITION BY publication_installations.user_id
      ORDER BY publication_installations.created_at ASC, publication_installations.id ASC
    ) AS install_rank
  FROM publication_installations
  JOIN publication_listings
    ON publication_listings.id = publication_installations.listing_id
  WHERE publication_listings.listing_type = 'skill'
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
  skill_installs.user_id,
  'first_skill_install',
  'market',
  skill_installs.id,
  json_object(
    'historicalBackfill', json('true'),
    'installs', skill_installs.installs
  ),
  skill_installs.created_at
FROM skill_installs
JOIN users ON users.id = skill_installs.user_id
WHERE skill_installs.install_rank = 1
  AND users.status != 'deleted';

-- APPS Skill usage is a separate badge and requires the listing to target the
-- APPS plane. This is the historical path missed by the first compensation.
WITH apps_skill_installs AS (
  SELECT
    publication_installations.id,
    publication_installations.user_id,
    publication_installations.created_at,
    COUNT(*) OVER (PARTITION BY publication_installations.user_id) AS installs,
    ROW_NUMBER() OVER (
      PARTITION BY publication_installations.user_id
      ORDER BY publication_installations.created_at ASC, publication_installations.id ASC
    ) AS install_rank
  FROM publication_installations
  JOIN publication_listings
    ON publication_listings.id = publication_installations.listing_id
  WHERE publication_listings.listing_type = 'skill'
    AND publication_listings.target_plane = 'apps'
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
  apps_skill_installs.user_id,
  'apps_skill_user',
  'market',
  apps_skill_installs.id,
  json_object(
    'historicalBackfill', json('true'),
    'installs', apps_skill_installs.installs,
    'targetPlane', 'apps'
  ),
  apps_skill_installs.created_at
FROM apps_skill_installs
JOIN users ON users.id = apps_skill_installs.user_id
WHERE apps_skill_installs.install_rank = 1
  AND users.status != 'deleted';

-- Workflow Explorer is the conjunction of an app launch and APPS Skill use.
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

-- Rebuild every persisted Journey projection so compensated badges immediately
-- restore badge totals, community totals, levels, and next-badge hints.
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
