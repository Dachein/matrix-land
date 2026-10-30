CREATE TABLE IF NOT EXISTS apps_app_secrets (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('preview', 'production')),
  description TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('declared', 'configured')) DEFAULT 'declared',
  cipher_text TEXT,
  cipher_iv TEXT,
  algorithm TEXT NOT NULL DEFAULT 'AES-GCM',
  configured_by TEXT,
  configured_at TEXT,
  declared_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(app_id, environment, name)
);

CREATE INDEX IF NOT EXISTS idx_apps_app_secrets_app ON apps_app_secrets(app_id, environment, name);

ALTER TABLE apps_apps ADD COLUMN llm_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE apps_apps ADD COLUMN llm_default_model TEXT;
ALTER TABLE apps_apps ADD COLUMN llm_endpoint TEXT;
