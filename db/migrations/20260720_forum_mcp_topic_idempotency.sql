ALTER TABLE forum_topics
ADD COLUMN idempotency_key TEXT;

ALTER TABLE forum_topics
ADD COLUMN content_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_forum_topics_author_idempotency
ON forum_topics(author_user_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_forum_topics_author_content_created
ON forum_topics(author_user_id, content_hash, created_at)
WHERE content_hash IS NOT NULL;
