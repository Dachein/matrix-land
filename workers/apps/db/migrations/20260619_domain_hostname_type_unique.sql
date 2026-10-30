PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS apps_domains_next (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('preview', 'production', 'mcp', 'custom')),
  environment TEXT NOT NULL CHECK (environment IN ('preview', 'production')),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(hostname, type)
);

INSERT OR IGNORE INTO apps_domains_next (
  id,
  app_id,
  hostname,
  type,
  environment,
  status,
  created_at
)
SELECT
  id,
  app_id,
  hostname,
  type,
  environment,
  status,
  created_at
FROM apps_domains;

DROP TABLE apps_domains;

ALTER TABLE apps_domains_next RENAME TO apps_domains;

CREATE INDEX IF NOT EXISTS idx_apps_domains_hostname ON apps_domains(hostname);

PRAGMA foreign_keys = ON;
