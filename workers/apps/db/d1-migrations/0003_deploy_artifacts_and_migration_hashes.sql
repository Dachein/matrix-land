CREATE TABLE IF NOT EXISTS apps_app_deploy_artifacts (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('pages', 'worker')),
  entrypoint TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  content_size_bytes INTEGER NOT NULL DEFAULT 0,
  archive_size_bytes INTEGER NOT NULL DEFAULT 0,
  manifest_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(app_id, archive_sha256)
);

CREATE INDEX IF NOT EXISTS idx_apps_app_deploy_artifacts_app
  ON apps_app_deploy_artifacts(app_id, created_at);

ALTER TABLE apps_deployments
ADD COLUMN deploy_artifact_id TEXT REFERENCES apps_app_deploy_artifacts(id) ON DELETE SET NULL;

ALTER TABLE apps_migration_registry
ADD COLUMN content_sha256 TEXT;

ALTER TABLE apps_migration_registry
ADD COLUMN file_name TEXT;
