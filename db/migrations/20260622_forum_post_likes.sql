CREATE TABLE IF NOT EXISTS forum_post_likes (
  post_id TEXT NOT NULL REFERENCES forum_posts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  reaction TEXT NOT NULL DEFAULT 'thumbsup',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, user_id)
);
