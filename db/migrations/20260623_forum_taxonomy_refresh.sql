INSERT OR IGNORE INTO forum_categories (id, name, slug, description, owner_team_id, sort_order) VALUES
  ('forum-ai-exploration', 'AI应用探索', 'ai-exploration', 'AI application exploration, cases, experiments, and practical observations.', 'team-ai-adoption', 10),
  ('forum-ai-investment', 'AI投资分享', 'ai-investment', 'AI investment sharing, market signals, and opportunity discussions.', NULL, 20),
  ('forum-platform-help', '公告与建议', 'platform-help', 'Announcements, suggestions, platform feedback, and official updates.', 'team-ai-adoption', 30),
  ('forum-off-topic', '杂谈与分享', 'off-topic', 'Casual conversations, off-topic community chat, and sharing.', NULL, 40);

UPDATE forum_topics
SET topic_type = 'official'
WHERE topic_type = 'announcement';

UPDATE forum_topics
SET topic_type = 'help'
WHERE topic_type = 'support';

UPDATE forum_topics
SET category_id = (SELECT id FROM forum_categories WHERE slug = 'ai-exploration' LIMIT 1)
WHERE EXISTS (SELECT 1 FROM forum_categories WHERE slug = 'ai-exploration')
  AND (
    category_id IN (
      SELECT id
      FROM forum_categories
      WHERE slug IN ('use-cases')
    )
    OR topic_type IN ('idea', 'showcase')
  );

UPDATE forum_topics
SET category_id = (SELECT id FROM forum_categories WHERE slug = 'platform-help' LIMIT 1)
WHERE EXISTS (SELECT 1 FROM forum_categories WHERE slug = 'platform-help')
  AND (
    category_id IN (
      SELECT id
      FROM forum_categories
      WHERE slug IN ('announcements', 'q-and-a', 'app-launch', 'mcp-data-services', 'skill-publishing')
    )
    OR topic_type IN ('help', 'question', 'official', 'release')
  );
