-- Publication visibility uses the same scope vocabulary as APPS assets.
-- Existing company-wide listings are organization-wide listings in practice.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE publication_listings_org_visibility (
  id TEXT PRIMARY KEY,
  listing_type TEXT NOT NULL CHECK (listing_type IN ('skill', 'app')),
  target_plane TEXT NOT NULL DEFAULT 'portal' CHECK (target_plane IN ('portal', 'apps')),
  target_id TEXT NOT NULL,
  listed_version_id TEXT NOT NULL DEFAULT '',
  review_version_id TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  owner_alias_name TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  cover_image_url TEXT NOT NULL DEFAULT '',
  category_id TEXT REFERENCES skill_categories(id),
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'listed', 'delisted', 'deleted')),
  desired_status TEXT NOT NULL DEFAULT 'pending_review' CHECK (desired_status IN ('pending_review', 'listed', 'delisted', 'deleted')),
  effective_status TEXT NOT NULL DEFAULT 'pending_review' CHECK (effective_status IN ('pending_review', 'listed', 'delisted', 'deleted')),
  publication_status TEXT NOT NULL DEFAULT 'synced' CHECK (publication_status IN ('synced', 'pending', 'failed', 'not_required')),
  publication_error_code TEXT NOT NULL DEFAULT '',
  publication_updated_at TEXT,
  visibility TEXT NOT NULL DEFAULT 'org' CHECK (visibility IN ('org', 'team', 'private')),
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
  review_notes TEXT NOT NULL DEFAULT '',
  builder_snapshot_json TEXT NOT NULL DEFAULT '{}',
  install_count INTEGER NOT NULL DEFAULT 0,
  agent_add_count INTEGER NOT NULL DEFAULT 0,
  zip_download_count INTEGER NOT NULL DEFAULT 0,
  visit_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  rating REAL NOT NULL DEFAULT 0,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(listing_type, target_id)
);

INSERT INTO publication_listings_org_visibility (
  id, listing_type, target_plane, target_id, listed_version_id, review_version_id,
  created_by_user_id, name, owner_alias_name, slug, summary, description,
  cover_image_url, category_id, tags_json, status, desired_status, effective_status,
  publication_status, publication_error_code, publication_updated_at, visibility,
  risk_level, review_notes, builder_snapshot_json, install_count, agent_add_count,
  zip_download_count, visit_count, comment_count, rating, published_at, created_at,
  updated_at
)
SELECT
  id, listing_type, target_plane, target_id, listed_version_id, review_version_id,
  created_by_user_id, name, owner_alias_name, slug, summary, description,
  cover_image_url, category_id, tags_json, status, desired_status, effective_status,
  publication_status, publication_error_code, publication_updated_at,
  CASE WHEN visibility = 'company' THEN 'org' ELSE visibility END,
  risk_level, review_notes, builder_snapshot_json, install_count, agent_add_count,
  zip_download_count, visit_count, comment_count, rating, published_at, created_at,
  updated_at
FROM publication_listings;

DROP TABLE publication_listings;
ALTER TABLE publication_listings_org_visibility RENAME TO publication_listings;

CREATE INDEX IF NOT EXISTS idx_publication_listings_type_status ON publication_listings(listing_type, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_publication_listings_effective_status ON publication_listings(listing_type, effective_status, updated_at);

PRAGMA defer_foreign_keys = OFF;
