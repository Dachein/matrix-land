-- Neutral categories required by the discussion composer in a fresh workspace.
INSERT INTO forum_categories(id,name,slug,sort_order) VALUES
 ('category-ai-exploration','AI exploration','ai-exploration',10),
 ('category-ai-investment','AI investment','ai-investment',20),
 ('category-platform-help','Platform help','platform-help',30),
 ('category-off-topic','General discussion','off-topic',40)
ON CONFLICT(slug) DO NOTHING;
