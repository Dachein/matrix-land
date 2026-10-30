CREATE TABLE IF NOT EXISTS apps_app_source_snapshots (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  archive_format TEXT NOT NULL DEFAULT 'zip' CHECK (archive_format IN ('zip')),
  file_count INTEGER NOT NULL DEFAULT 0,
  source_size_bytes INTEGER NOT NULL DEFAULT 0,
  archive_size_bytes INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(app_id, archive_sha256)
);

CREATE INDEX IF NOT EXISTS idx_apps_app_source_snapshots_app
  ON apps_app_source_snapshots(app_id, created_at);

ALTER TABLE apps_deployments
ADD COLUMN source_snapshot_id TEXT REFERENCES apps_app_source_snapshots(id) ON DELETE SET NULL;
