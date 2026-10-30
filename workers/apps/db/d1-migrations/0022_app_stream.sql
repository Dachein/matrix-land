-- Stream is account-wide; these tables are the platform's App isolation boundary.
CREATE TABLE IF NOT EXISTS apps_stream_app_grants (
  app_id TEXT PRIMARY KEY REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apps_stream_videos (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  max_duration_seconds INTEGER NOT NULL,
  stream_uid TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('creating', 'uploading', 'failed', 'deleted')),
  upload_url TEXT,
  protocol TEXT CHECK (protocol IN ('post', 'tus')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(app_id, object_id)
);
CREATE INDEX IF NOT EXISTS idx_apps_stream_app_videos ON apps_stream_videos(app_id, org_id, created_at);
