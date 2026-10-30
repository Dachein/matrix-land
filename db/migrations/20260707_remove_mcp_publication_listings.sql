PRAGMA foreign_keys=off;

DELETE FROM publication_comments
WHERE listing_id IN (
  SELECT id FROM publication_listings WHERE listing_type = 'mcp'
);

DELETE FROM publication_installations
WHERE listing_id IN (
  SELECT id FROM publication_listings WHERE listing_type = 'mcp'
);

DELETE FROM publication_versions
WHERE listing_id IN (
  SELECT id FROM publication_listings WHERE listing_type = 'mcp'
);

DELETE FROM publication_listings
WHERE listing_type = 'mcp';

DROP INDEX IF EXISTS idx_publication_listings_type_status;
DROP INDEX IF EXISTS idx_publication_versions_listing;

CREATE TABLE publication_versions_new (
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

INSERT INTO publication_versions_new (
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
FROM publication_versions
WHERE artifact_type IN ('skill_md', 'app_config', 'document', 'package');

DROP TABLE publication_versions;

ALTER TABLE publication_versions_new RENAME TO publication_versions;

CREATE TABLE publication_listings_new (
  id TEXT PRIMARY KEY,
  listing_type TEXT NOT NULL CHECK (listing_type IN ('skill', 'app')),
  target_plane TEXT NOT NULL DEFAULT 'portal' CHECK (target_plane IN ('portal', 'apps')),
  target_id TEXT NOT NULL,
  listed_version_id TEXT NOT NULL DEFAULT '',
  review_version_id TEXT NOT NULL DEFAULT '',
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
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
  review_notes TEXT NOT NULL DEFAULT '',
  builder_snapshot_json TEXT NOT NULL DEFAULT '{}',
  install_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  rating REAL NOT NULL DEFAULT 0,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(listing_type, target_id)
);

INSERT INTO publication_listings_new (
  id,
  listing_type,
  target_plane,
  target_id,
  listed_version_id,
  review_version_id,
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
  risk_level,
  review_notes,
  builder_snapshot_json,
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
  target_plane,
  target_id,
  listed_version_id,
  review_version_id,
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
  risk_level,
  review_notes,
  builder_snapshot_json,
  install_count,
  comment_count,
  rating,
  published_at,
  created_at,
  updated_at
FROM publication_listings;

DROP TABLE publication_listings;

ALTER TABLE publication_listings_new RENAME TO publication_listings;

CREATE INDEX IF NOT EXISTS idx_publication_listings_type_status ON publication_listings(listing_type, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_publication_versions_listing ON publication_versions(listing_id, created_at);

PRAGMA foreign_keys=on;
