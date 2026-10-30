ALTER TABLE forum_posts
ADD COLUMN source TEXT NOT NULL DEFAULT 'portal' CHECK (source IN ('portal', 'mcp'));

UPDATE forum_posts
SET source = 'mcp'
WHERE id IN (
  SELECT (
    SELECT root_post.id
    FROM forum_posts AS root_post
    WHERE root_post.topic_id = forum_topics.id
      AND root_post.parent_post_id IS NULL
    ORDER BY root_post.created_at, root_post.id
    LIMIT 1
  )
  FROM forum_topics
  WHERE forum_topics.source = 'mcp'
);

UPDATE forum_posts
SET source = 'mcp'
WHERE id = 'a0dc9b16-c3bc-4c44-b680-c53c17b581c9';
