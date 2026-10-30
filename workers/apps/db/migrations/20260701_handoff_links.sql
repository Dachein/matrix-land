CREATE TABLE IF NOT EXISTS apps_handoff_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '["apps:apps:handoff"]',
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_apps_handoff_links_app ON apps_handoff_links(app_id, expires_at);
