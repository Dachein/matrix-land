UPDATE forum_topics
SET category_id = (SELECT id FROM forum_categories WHERE slug = 'platform-help')
WHERE category_id = (SELECT id FROM forum_categories WHERE slug = 'announcements')
  AND topic_type IN ('question', 'support')
  AND EXISTS (SELECT 1 FROM forum_categories WHERE slug = 'platform-help');

UPDATE forum_topics
SET category_id = (SELECT id FROM forum_categories WHERE slug = 'ai-exploration')
WHERE category_id = (SELECT id FROM forum_categories WHERE slug = 'announcements')
  AND topic_type IN ('showcase', 'idea')
  AND EXISTS (SELECT 1 FROM forum_categories WHERE slug = 'ai-exploration');
