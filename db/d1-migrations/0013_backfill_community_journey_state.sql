-- Ensure every existing Portal user has a Journey projection before profile
-- cards read the community contribution subtotal.
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
  WHERE forum_posts.parent_post_id IS NOT NULL
    AND forum_topics.status != 'archived'
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
SET current_level_key = CASE
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
updated_at = CURRENT_TIMESTAMP;
