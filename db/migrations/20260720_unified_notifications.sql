CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_user_id TEXT NOT NULL REFERENCES users(id),
  actor_user_id TEXT REFERENCES users(id),
  notification_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  parent_type TEXT,
  parent_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  href TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_status_created
  ON notifications(recipient_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_entity
  ON notifications(entity_type, entity_id, created_at DESC);

INSERT OR IGNORE INTO notifications (
  id,
  recipient_user_id,
  actor_user_id,
  notification_type,
  entity_type,
  entity_id,
  parent_type,
  parent_id,
  summary,
  href,
  metadata_json,
  dedupe_key,
  status,
  created_at,
  read_at
)
SELECT
  forum_notifications.id,
  forum_notifications.recipient_user_id,
  forum_notifications.actor_user_id,
  'forum.mention',
  CASE WHEN forum_notifications.post_id IS NOT NULL THEN 'forum_post' ELSE 'forum_topic' END,
  COALESCE(forum_notifications.post_id, forum_notifications.topic_id, forum_notifications.id),
  CASE WHEN forum_notifications.topic_id IS NOT NULL THEN 'forum_topic' END,
  forum_notifications.topic_id,
  COALESCE(actor.name, 'Someone') || ' 提到了你' ||
    CASE WHEN forum_topics.title IS NOT NULL AND forum_topics.title != '' THEN '：《' || forum_topics.title || '》' ELSE '' END,
  CASE WHEN forum_notifications.topic_id IS NOT NULL THEN '#/posts/' || forum_notifications.topic_id ELSE '' END,
  '{}',
  'legacy:forum-notification:' || forum_notifications.id,
  CASE WHEN forum_notifications.status = 'read' THEN 'read' ELSE 'unread' END,
  forum_notifications.created_at,
  forum_notifications.read_at
FROM forum_notifications
LEFT JOIN users AS actor ON actor.id = forum_notifications.actor_user_id
LEFT JOIN forum_topics ON forum_topics.id = forum_notifications.topic_id;
