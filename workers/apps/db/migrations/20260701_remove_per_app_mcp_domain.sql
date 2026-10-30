PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS apps_domains_next (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('production', 'custom')),
  environment TEXT NOT NULL CHECK (environment IN ('production')),
  status TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'cloudflare',
  provider_resource_id TEXT,
  dns_record_id TEXT,
  route_id TEXT,
  certificate_status TEXT NOT NULL DEFAULT 'unknown',
  route_status TEXT NOT NULL DEFAULT 'unknown',
  fallback_url TEXT,
  last_checked_at TEXT,
  error_code TEXT,
  error_message TEXT,
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
  provider,
  provider_resource_id,
  dns_record_id,
  route_id,
  certificate_status,
  route_status,
  fallback_url,
  last_checked_at,
  error_code,
  error_message,
  created_at
)
SELECT
  id,
  app_id,
  hostname,
  type,
  'production',
  status,
  provider,
  provider_resource_id,
  dns_record_id,
  route_id,
  certificate_status,
  route_status,
  fallback_url,
  last_checked_at,
  error_code,
  error_message,
  created_at
FROM apps_domains
WHERE type IN ('production', 'custom');

DROP TABLE IF EXISTS apps_domains;
ALTER TABLE apps_domains_next RENAME TO apps_domains;

CREATE INDEX IF NOT EXISTS idx_apps_domains_hostname ON apps_domains(hostname);

PRAGMA foreign_keys = ON;
