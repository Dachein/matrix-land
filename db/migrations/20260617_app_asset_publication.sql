ALTER TABLE skills ADD COLUMN deleted_at TEXT;

ALTER TABLE apps ADD COLUMN publisher_user_id TEXT REFERENCES users(id);
ALTER TABLE apps ADD COLUMN business_owner_user_id TEXT REFERENCES users(id);
ALTER TABLE apps ADD COLUMN subtitle TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN deployment_type TEXT NOT NULL DEFAULT 'saas';
ALTER TABLE apps ADD COLUMN data_types_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE apps ADD COLUMN knowledge_sources_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE apps ADD COLUMN user_scope TEXT NOT NULL DEFAULT 'department';
ALTER TABLE apps ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'low';
ALTER TABLE apps ADD COLUMN risk_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN permission_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN output_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN current_version TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE apps ADD COLUMN changelog TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN listed_at TEXT;
ALTER TABLE apps ADD COLUMN delisted_at TEXT;
ALTER TABLE apps ADD COLUMN deleted_at TEXT;

ALTER TABLE app_catalog_metadata ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE app_catalog_metadata ADD COLUMN screenshots_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE app_catalog_metadata ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_catalog_metadata ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_catalog_metadata ADD COLUMN favorite_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_catalog_metadata ADD COLUMN rating REAL NOT NULL DEFAULT 0;
ALTER TABLE app_catalog_metadata ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_catalog_metadata ADD COLUMN discussion_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_catalog_metadata ADD COLUMN active_user_count INTEGER NOT NULL DEFAULT 0;

UPDATE skills
SET status = CASE status
  WHEN 'approved' THEN 'listed'
  WHEN 'published' THEN 'listed'
  WHEN 'listed' THEN 'listed'
  WHEN 'review' THEN 'pending_review'
  WHEN 'limited' THEN 'pending_review'
  WHEN 'draft' THEN 'pending_review'
  WHEN 'blocked' THEN 'delisted'
  WHEN 'archived' THEN 'delisted'
  WHEN 'delisted' THEN 'delisted'
  WHEN 'deleted' THEN 'deleted'
  ELSE 'pending_review'
END;

UPDATE mcp_servers
SET status = CASE status
  WHEN 'approved' THEN 'listed'
  WHEN 'published' THEN 'listed'
  WHEN 'listed' THEN 'listed'
  WHEN 'review' THEN 'pending_review'
  WHEN 'limited' THEN 'pending_review'
  WHEN 'draft' THEN 'pending_review'
  WHEN 'blocked' THEN 'delisted'
  WHEN 'archived' THEN 'delisted'
  WHEN 'delisted' THEN 'delisted'
  WHEN 'deleted' THEN 'deleted'
  ELSE 'pending_review'
END;

UPDATE mcp_tools
SET status = CASE status
  WHEN 'approved' THEN 'listed'
  WHEN 'published' THEN 'listed'
  WHEN 'listed' THEN 'listed'
  WHEN 'review' THEN 'pending_review'
  WHEN 'limited' THEN 'pending_review'
  WHEN 'draft' THEN 'pending_review'
  WHEN 'blocked' THEN 'delisted'
  WHEN 'archived' THEN 'delisted'
  WHEN 'delisted' THEN 'delisted'
  WHEN 'deleted' THEN 'deleted'
  ELSE 'pending_review'
END;

DROP INDEX IF EXISTS idx_publication_listings_type_status;
DROP INDEX IF EXISTS idx_publication_listings_owner;
DROP INDEX IF EXISTS idx_publication_installations_user;
DROP INDEX IF EXISTS idx_publication_installations_listing;
DROP INDEX IF EXISTS idx_publication_comments_listing;
DROP INDEX IF EXISTS idx_publication_versions_listing;

ALTER TABLE publication_installations RENAME TO publication_installations_old;
ALTER TABLE publication_comments RENAME TO publication_comments_old;
ALTER TABLE publication_versions RENAME TO publication_versions_old;
ALTER TABLE publication_listings RENAME TO publication_listings_old;

CREATE TABLE publication_listings (
  id TEXT PRIMARY KEY,
  listing_type TEXT NOT NULL CHECK (listing_type IN ('skill', 'app')),
  target_id TEXT NOT NULL,
  owner_team_id TEXT NOT NULL REFERENCES teams(id),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  cover_image_url TEXT NOT NULL DEFAULT '',
  category_id TEXT REFERENCES skill_categories(id),
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'listed', 'delisted', 'deleted')),
  visibility TEXT NOT NULL DEFAULT 'company' CHECK (visibility IN ('company', 'team', 'private')),
  install_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  rating REAL NOT NULL DEFAULT 0,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(listing_type, target_id)
);

CREATE TABLE publication_installations (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES publication_listings(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  version TEXT,
  install_type TEXT NOT NULL DEFAULT 'user' CHECK (install_type IN ('user', 'team', 'download', 'bookmark')),
  source TEXT NOT NULL DEFAULT 'publication',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(listing_id, user_id, install_type)
);

CREATE TABLE publication_comments (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES publication_listings(id),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  parent_comment_id TEXT REFERENCES publication_comments(id),
  body_markdown TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'deleted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE publication_versions (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES publication_listings(id),
  version TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('skill_md', 'app_config', 'document', 'package')),
  artifact_url TEXT,
  artifact_body TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  changelog TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(listing_id, version)
);

INSERT INTO publication_listings (
  id,
  listing_type,
  target_id,
  owner_team_id,
  created_by_user_id,
  name,
  slug,
  summary,
  description,
  cover_image_url,
  category_id,
  tags_json,
  status,
  visibility,
  install_count,
  comment_count,
  rating,
  published_at,
  created_at,
  updated_at
)
SELECT
  id,
  listing_type,
  target_id,
  owner_team_id,
  created_by_user_id,
  name,
  slug,
  summary,
  description,
  cover_image_url,
  category_id,
  tags_json,
  CASE status
    WHEN 'published' THEN 'listed'
    WHEN 'approved' THEN 'listed'
    WHEN 'listed' THEN 'listed'
    WHEN 'archived' THEN 'delisted'
    WHEN 'blocked' THEN 'delisted'
    WHEN 'delisted' THEN 'delisted'
    WHEN 'deleted' THEN 'deleted'
    ELSE 'pending_review'
  END,
  visibility,
  install_count,
  comment_count,
  rating,
  published_at,
  created_at,
  updated_at
FROM publication_listings_old;

INSERT INTO publication_installations (
  id,
  listing_id,
  user_id,
  team_id,
  version,
  install_type,
  source,
  created_at
)
SELECT
  id,
  listing_id,
  user_id,
  team_id,
  version,
  install_type,
  source,
  created_at
FROM publication_installations_old;

INSERT INTO publication_comments (
  id,
  listing_id,
  author_user_id,
  parent_comment_id,
  body_markdown,
  status,
  created_at,
  updated_at
)
SELECT
  id,
  listing_id,
  author_user_id,
  parent_comment_id,
  body_markdown,
  status,
  created_at,
  updated_at
FROM publication_comments_old
ORDER BY CASE WHEN parent_comment_id IS NULL THEN 0 ELSE 1 END, created_at;

INSERT INTO publication_versions (
  id,
  listing_id,
  version,
  artifact_type,
  artifact_url,
  artifact_body,
  config_json,
  changelog,
  created_by_user_id,
  created_at
)
SELECT
  id,
  listing_id,
  version,
  artifact_type,
  artifact_url,
  artifact_body,
  config_json,
  changelog,
  created_by_user_id,
  created_at
FROM publication_versions_old;

DROP TABLE publication_installations_old;
DROP TABLE publication_comments_old;
DROP TABLE publication_versions_old;
DROP TABLE publication_listings_old;

CREATE INDEX IF NOT EXISTS idx_publication_listings_type_status ON publication_listings(listing_type, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_publication_listings_owner ON publication_listings(owner_team_id, status);
CREATE INDEX IF NOT EXISTS idx_publication_installations_user ON publication_installations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_publication_installations_listing ON publication_installations(listing_id, created_at);
CREATE INDEX IF NOT EXISTS idx_publication_comments_listing ON publication_comments(listing_id, created_at);
CREATE INDEX IF NOT EXISTS idx_publication_versions_listing ON publication_versions(listing_id, created_at);

UPDATE apps
SET publisher_user_id = CASE id
  WHEN 'app-ops-copilot' THEN '00000000-0000-0000-0000-000000000004'
  WHEN 'app-growth-lab' THEN '00000000-0000-0000-0000-000000000005'
  WHEN 'app-knowledge-map' THEN '00000000-0000-0000-0000-000000000003'
  ELSE publisher_user_id
END
WHERE publisher_user_id IS NULL;

UPDATE apps
SET business_owner_user_id = COALESCE(business_owner_user_id, publisher_user_id);

UPDATE apps
SET status = 'listed',
    listed_at = COALESCE(listed_at, updated_at)
WHERE id IN ('app-ops-copilot', 'app-knowledge-map');

UPDATE apps
SET status = 'pending_review'
WHERE id = 'app-growth-lab';

UPDATE apps
SET
  subtitle = 'Operations triage and handoff copilot',
  model = 'GPT-4o mini + DeepSeek Chat',
  deployment_type = 'private',
  data_types_json = '["Internal operations data","Incident notes"]',
  knowledge_sources_json = '["Operations runbooks RAG","Policy handoff checklist"]',
  user_scope = 'department',
  risk_level = 'high',
  risk_reason = 'Uses operations write scope and can update incident handoff notes.',
  permission_notes = 'Requires profile:read, ops:read, and ops:write through scoped Direct Jump tokens.',
  output_notes = 'Produces internal triage summaries and suggested handoff actions for operations teams.',
  current_version = '1.0.0',
  changelog = 'Initial Workspace SDK Direct Jump configuration.'
WHERE id = 'app-ops-copilot';

UPDATE apps
SET
  subtitle = 'Experiment planning for revenue teams',
  model = 'Claude Sonnet',
  deployment_type = 'saas',
  data_types_json = '["Internal analytics","Experiment metadata"]',
  knowledge_sources_json = '["Growth experiment archive","Public benchmark notes"]',
  user_scope = 'department',
  risk_level = 'medium',
  risk_reason = 'Reads internal analytics data with scoped access and no external publishing.',
  permission_notes = 'Requires profile:read and analytics:read. Write actions are not enabled.',
  output_notes = 'Produces experiment briefs and planning recommendations for internal review.',
  current_version = '0.9.0',
  changelog = 'Prepared SDK callback validation and analytics read scope review.'
WHERE id = 'app-growth-lab';

UPDATE apps
SET
  subtitle = 'Search approved AI playbooks and examples',
  model = 'GPT-4o',
  deployment_type = 'serverless',
  data_types_json = '["Public information","Approved internal playbooks"]',
  knowledge_sources_json = '["AI Adoption playbook RAG","Approved prompt examples"]',
  user_scope = 'all',
  risk_level = 'low',
  risk_reason = 'Uses approved knowledge and public information as a read-only assistive tool.',
  permission_notes = 'Requires profile:read and knowledge:read. No write scopes.',
  output_notes = 'Produces search summaries and links to approved internal examples.',
  current_version = '1.2.0',
  changelog = 'Adds curated prompt pattern search and richer source citations.'
WHERE id = 'app-knowledge-map';
