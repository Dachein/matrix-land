CREATE TABLE IF NOT EXISTS apps_app_source_versions (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('production')),
  version TEXT NOT NULL,
  deployment_id TEXT REFERENCES apps_deployments(id) ON DELETE SET NULL,
  artifact_key TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  entrypoint TEXT NOT NULL DEFAULT 'index.html',
  file_count INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(app_id, environment, version)
);

CREATE INDEX IF NOT EXISTS idx_apps_app_source_versions_app
  ON apps_app_source_versions(app_id, environment, created_at);
