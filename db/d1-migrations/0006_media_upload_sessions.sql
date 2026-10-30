CREATE TABLE IF NOT EXISTS media_upload_sessions (
  upload_id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  declared_size INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  owner_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finalized_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_media_upload_sessions_pending
  ON media_upload_sessions (status, expires_at);
