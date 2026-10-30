ALTER TABLE auth_app_clients ADD COLUMN app_secret_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE auth_app_clients ADD COLUMN app_secret_name TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS auth_app_launch_codes (
  code_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_json TEXT NOT NULL DEFAULT '{}',
  callback_url TEXT NOT NULL DEFAULT '',
  redirect_url TEXT,
  request_id TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_app_launch_codes_app_user ON auth_app_launch_codes(app_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_app_launch_codes_expires ON auth_app_launch_codes(expires_at);
