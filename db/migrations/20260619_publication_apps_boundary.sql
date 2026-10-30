ALTER TABLE publication_listings ADD COLUMN target_plane TEXT NOT NULL DEFAULT 'portal';
ALTER TABLE publication_listings ADD COLUMN listed_version_id TEXT NOT NULL DEFAULT '';
ALTER TABLE publication_listings ADD COLUMN review_version_id TEXT NOT NULL DEFAULT '';
ALTER TABLE publication_listings ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'low';
ALTER TABLE publication_listings ADD COLUMN review_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE publication_listings ADD COLUMN builder_snapshot_json TEXT NOT NULL DEFAULT '{}';
