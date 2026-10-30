CREATE TABLE IF NOT EXISTS auth_resource_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  audience TEXT NOT NULL DEFAULT '',
  access_mode TEXT NOT NULL DEFAULT 'public' CHECK (access_mode IN ('public', 'request', 'targeted')),
  access_targets_json TEXT NOT NULL DEFAULT '[]',
  allowed_scopes_json TEXT NOT NULL DEFAULT '[]',
  publisher_user_id TEXT,
  business_owner_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_resource_clients_status ON auth_resource_clients(status, updated_at);
