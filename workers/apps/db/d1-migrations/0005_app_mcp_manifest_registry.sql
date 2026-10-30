CREATE TABLE IF NOT EXISTS apps_app_mcp_manifests (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES apps_deployments(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL,
  tool_definition_version TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(app_id, deployment_id)
);

CREATE INDEX IF NOT EXISTS idx_apps_app_mcp_manifests_app
  ON apps_app_mcp_manifests(app_id, created_at DESC);
