CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'community_admin')),
  assigned_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role_user
ON user_roles(role, user_id);

INSERT OR IGNORE INTO user_roles (user_id, role)
SELECT id, 'admin'
FROM users
WHERE role = 'admin';

ALTER TABLE forum_topics ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE forum_topics ADD COLUMN pinned_by_user_id TEXT REFERENCES users(id);
ALTER TABLE forum_topics ADD COLUMN pinned_at TEXT;

ALTER TABLE forum_posts ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE forum_posts ADD COLUMN pinned_by_user_id TEXT REFERENCES users(id);
ALTER TABLE forum_posts ADD COLUMN pinned_at TEXT;

CREATE INDEX IF NOT EXISTS idx_forum_topics_pinned_active
ON forum_topics(is_pinned, pinned_at, last_active_at);

CREATE INDEX IF NOT EXISTS idx_forum_posts_topic_pinned_created
ON forum_posts(topic_id, is_pinned, pinned_at, created_at);
