PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS apps_apps_next (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('static_page', 'web', 'data_mcp', 'automation', 'container')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'provisioning', 'preview', 'published', 'archived')),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'team', 'org', 'public')),
  login_required INTEGER NOT NULL DEFAULT 1,
  llm_enabled INTEGER NOT NULL DEFAULT 0,
  llm_default_model TEXT,
  llm_endpoint TEXT,
  data_service_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_id, code),
  UNIQUE(org_id, slug)
);

INSERT OR IGNORE INTO apps_apps_next (
  id,
  org_id,
  org_slug,
  owner_user_id,
  name,
  code,
  slug,
  description,
  type,
  status,
  visibility,
  login_required,
  llm_enabled,
  llm_default_model,
  llm_endpoint,
  data_service_id,
  created_at,
  updated_at
)
SELECT
  id,
  org_id,
  org_slug,
  owner_user_id,
  name,
  COALESCE(NULLIF(code, ''), slug),
  slug,
  description,
  type,
  status,
  visibility,
  login_required,
  COALESCE(llm_enabled, 0),
  llm_default_model,
  llm_endpoint,
  data_service_id,
  created_at,
  updated_at
FROM apps_apps;

DROP TABLE apps_apps;

ALTER TABLE apps_apps_next RENAME TO apps_apps;

CREATE INDEX IF NOT EXISTS idx_apps_apps_owner ON apps_apps(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_apps_apps_org_status ON apps_apps(org_id, status);

PRAGMA foreign_keys = ON;
