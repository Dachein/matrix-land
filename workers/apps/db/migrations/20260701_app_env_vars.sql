CREATE TABLE IF NOT EXISTS apps_app_env_vars (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('runtime', 'pages', 'worker')) DEFAULT 'runtime',
  environment TEXT NOT NULL CHECK (environment IN ('production')) DEFAULT 'production',
  value TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(app_id, environment, target, name)
);

CREATE INDEX IF NOT EXISTS idx_apps_app_env_vars_app
  ON apps_app_env_vars(app_id, environment, target, name);
