CREATE TABLE IF NOT EXISTS forum_contributor_awards (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  post_id TEXT NOT NULL UNIQUE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id),
  awarded_by_user_id TEXT NOT NULL REFERENCES users(id),
  points INTEGER NOT NULL DEFAULT 10 CHECK (points BETWEEN 1 AND 100),
  note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_forum_contributor_awards_recipient_created
ON forum_contributor_awards(recipient_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_forum_contributor_awards_topic_created
ON forum_contributor_awards(topic_id, created_at DESC);

ALTER TABLE portal_user_journey_state
ADD COLUMN community_contribution_points INTEGER NOT NULL DEFAULT 0 CHECK (community_contribution_points >= 0);

WITH community_events AS (
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
  total_points = total_points + COALESCE((
    SELECT community_totals.points
    FROM community_totals
    WHERE community_totals.user_id = portal_user_journey_state.user_id
  ), 0);
