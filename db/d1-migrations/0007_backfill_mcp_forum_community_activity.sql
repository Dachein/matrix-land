INSERT OR IGNORE INTO activity_events (
  id,
  scenario,
  action_type,
  actor_user_id,
  actor_name,
  actor_avatar_url,
  actor_team,
  target_type,
  target_id,
  target_title,
  parent_type,
  parent_id,
  parent_title,
  summary,
  href,
  visibility,
  team_id,
  metadata_json,
  source,
  source_event_id,
  created_at
)
SELECT
  'mcp-forum-topic-community:' || forum_topics.id,
  'community',
  'forum.topic.created',
  forum_topics.author_user_id,
  users.name,
  COALESCE(users.avatar_url, ''),
  COALESCE(teams.name, ''),
  'forum_topic',
  forum_topics.id,
  forum_topics.title,
  NULL,
  NULL,
  NULL,
  users.name || ' 发布了帖子《' || forum_topics.title || '》',
  '#/community/' || forum_topics.id,
  'org',
  forum_topics.bu_team_id,
  json_object(
    'backfilled', json('true'),
    'postId', (
      SELECT root_post.id
      FROM forum_posts AS root_post
      WHERE root_post.topic_id = forum_topics.id
      ORDER BY root_post.created_at ASC, root_post.id ASC
      LIMIT 1
    )
  ),
  'mcp',
  'forum.topic.created:' || forum_topics.id,
  forum_topics.created_at
FROM forum_topics
JOIN users ON users.id = forum_topics.author_user_id
LEFT JOIN teams ON teams.id = forum_topics.bu_team_id
WHERE forum_topics.source = 'mcp';

INSERT OR IGNORE INTO activity_events (
  id,
  scenario,
  action_type,
  actor_user_id,
  actor_name,
  actor_avatar_url,
  actor_team,
  target_type,
  target_id,
  target_title,
  parent_type,
  parent_id,
  parent_title,
  summary,
  href,
  visibility,
  team_id,
  metadata_json,
  source,
  source_event_id,
  created_at
)
SELECT
  'mcp-forum-reply-community:' || forum_posts.id,
  'community',
  'forum.reply.created',
  forum_posts.author_user_id,
  users.name,
  COALESCE(users.avatar_url, ''),
  COALESCE(teams.name, ''),
  'forum_post',
  forum_posts.id,
  '回复',
  'forum_topic',
  forum_topics.id,
  forum_topics.title,
  users.name || ' 回复了帖子《' || forum_topics.title || '》',
  '#/community/' || forum_topics.id,
  'org',
  users.team_id,
  json_object(
    'backfilled', json('true'),
    'postId', forum_posts.id,
    'replyPreview', substr(
      trim(replace(replace(forum_posts.body_markdown, char(13), ' '), char(10), ' ')),
      1,
      180
    )
  ),
  'mcp',
  'forum.reply.created:' || forum_posts.id,
  forum_posts.created_at
FROM forum_posts
JOIN forum_topics ON forum_topics.id = forum_posts.topic_id
JOIN users ON users.id = forum_posts.author_user_id
LEFT JOIN teams ON teams.id = users.team_id
WHERE forum_posts.source = 'mcp'
  AND forum_posts.id <> (
    SELECT root_post.id
    FROM forum_posts AS root_post
    WHERE root_post.topic_id = forum_posts.topic_id
    ORDER BY root_post.created_at ASC, root_post.id ASC
    LIMIT 1
  );
