UPDATE skill_categories
SET name = name || ' Legacy',
    slug = slug || '-legacy'
WHERE lower(name) IN ('coding', 'design', 'media', 'research', 'finance', 'workflow', 'office')
  AND id NOT IN ('category-coding', 'category-design', 'category-media', 'category-research', 'category-finance', 'category-workflow', 'category-office');

INSERT OR IGNORE INTO skill_categories (id, name, slug) VALUES
  ('category-coding', 'Coding', 'coding'),
  ('category-design', 'Design', 'design'),
  ('category-media', 'Media', 'media'),
  ('category-research', 'Research', 'research'),
  ('category-finance', 'Finance', 'finance'),
  ('category-workflow', 'Workflow', 'workflow'),
  ('category-office', 'Office', 'office');

UPDATE publication_listings
SET category_id = 'category-design'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('design', '设计', '设计创作'));

UPDATE skill_catalog_metadata
SET category_id = 'category-design'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('design', '设计', '设计创作'));

UPDATE app_catalog_metadata
SET category_id = 'category-design'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('design', '设计', '设计创作'));

UPDATE publication_listings
SET category_id = 'category-workflow'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('workflow', 'apps', 'app', 'operations', '流程处理', '内部流程'));

UPDATE skill_catalog_metadata
SET category_id = 'category-workflow'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('workflow', 'apps', 'app', 'operations', '流程处理', '内部流程'));

UPDATE app_catalog_metadata
SET category_id = 'category-workflow'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('workflow', 'apps', 'app', 'operations', '流程处理', '内部流程'));

UPDATE publication_listings
SET category_id = 'category-coding'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('coding', 'dev', 'developer tools', 'platform', 'mcp', 'mcp service', '开发工具'));

UPDATE skill_catalog_metadata
SET category_id = 'category-coding'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('coding', 'dev', 'developer tools', 'platform', 'mcp', 'mcp service', '开发工具'));

UPDATE app_catalog_metadata
SET category_id = 'category-coding'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('coding', 'dev', 'developer tools', 'platform', 'mcp', 'mcp service', '开发工具'));

UPDATE publication_listings
SET category_id = 'category-media'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('media', '多媒体', '媒体处理'));

UPDATE skill_catalog_metadata
SET category_id = 'category-media'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('media', '多媒体', '媒体处理'));

UPDATE app_catalog_metadata
SET category_id = 'category-media'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('media', '多媒体', '媒体处理'));

UPDATE publication_listings
SET category_id = 'category-research'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('research', 'knowledge', 'search', '知识', '知识管理', '知识研究', '搜索研究'));

UPDATE skill_catalog_metadata
SET category_id = 'category-research'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('research', 'knowledge', 'search', '知识', '知识管理', '知识研究', '搜索研究'));

UPDATE app_catalog_metadata
SET category_id = 'category-research'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('research', 'knowledge', 'search', '知识', '知识管理', '知识研究', '搜索研究'));

UPDATE publication_listings
SET category_id = 'category-finance'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('finance', 'financial research', 'investment', 'revenue', '投资', '金融', '金融投研'));

UPDATE skill_catalog_metadata
SET category_id = 'category-finance'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('finance', 'financial research', 'investment', 'revenue', '投资', '金融', '金融投研'));

UPDATE app_catalog_metadata
SET category_id = 'category-finance'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('finance', 'financial research', 'investment', 'revenue', '投资', '金融', '金融投研'));

UPDATE publication_listings
SET category_id = 'category-office'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('office', 'file', 'files', 'legal', '办公协同', '办公文件', '文件办公', '文件处理'));

UPDATE skill_catalog_metadata
SET category_id = 'category-office'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('office', 'file', 'files', 'legal', '办公协同', '办公文件', '文件办公', '文件处理'));

UPDATE app_catalog_metadata
SET category_id = 'category-office'
WHERE category_id IN (SELECT id FROM skill_categories WHERE lower(name) IN ('office', 'file', 'files', 'legal', '办公协同', '办公文件', '文件办公', '文件处理'));
