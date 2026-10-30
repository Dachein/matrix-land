PRAGMA foreign_keys = ON;

-- Release bodies move to immutable R2 objects. Existing Releases remain
-- readable from the legacy inline JSON columns until explicitly backfilled.
ALTER TABLE apps_mate_releases ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'inline';
ALTER TABLE apps_mate_releases ADD COLUMN manifest_r2_key TEXT;
ALTER TABLE apps_mate_releases ADD COLUMN manifest_size_bytes INTEGER;

CREATE TABLE IF NOT EXISTS apps_mate_definition_revisions (
  id TEXT PRIMARY KEY,
  mate_id TEXT NOT NULL REFERENCES apps_mates(id) ON DELETE CASCADE,
  definition_type TEXT NOT NULL CHECK (definition_type IN ('soul', 'handbook')),
  version INTEGER NOT NULL CHECK (version >= 1),
  digest TEXT NOT NULL,
  r2_object_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  source TEXT NOT NULL DEFAULT 'native' CHECK (source IN ('native', 'legacy_inline_import')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(mate_id, definition_type, digest),
  UNIQUE(r2_object_key)
);

CREATE TABLE IF NOT EXISTS apps_mate_release_definitions (
  release_id TEXT NOT NULL REFERENCES apps_mate_releases(id) ON DELETE CASCADE,
  definition_revision_id TEXT NOT NULL REFERENCES apps_mate_definition_revisions(id),
  definition_type TEXT NOT NULL CHECK (definition_type IN ('soul', 'handbook')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  document_id TEXT NOT NULL,
  document_version INTEGER NOT NULL CHECK (document_version >= 1),
  document_digest TEXT NOT NULL,
  PRIMARY KEY (release_id, definition_type, ordinal),
  UNIQUE(release_id, definition_revision_id)
);

CREATE INDEX IF NOT EXISTS idx_mate_definition_revisions_version
  ON apps_mate_definition_revisions(mate_id, definition_type, version DESC);

CREATE INDEX IF NOT EXISTS idx_mate_release_definitions_release
  ON apps_mate_release_definitions(release_id, definition_type, ordinal);
