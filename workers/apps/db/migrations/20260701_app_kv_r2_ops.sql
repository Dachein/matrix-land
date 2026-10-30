CREATE TABLE IF NOT EXISTS apps_app_kv_items (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(app_id, key)
);

CREATE TABLE IF NOT EXISTS apps_app_r2_objects (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  etag TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(app_id, object_key)
);

CREATE INDEX IF NOT EXISTS idx_apps_app_kv_items_app ON apps_app_kv_items(app_id, key);
CREATE INDEX IF NOT EXISTS idx_apps_app_r2_objects_app ON apps_app_r2_objects(app_id, object_key);
