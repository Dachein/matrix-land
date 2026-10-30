CREATE TABLE IF NOT EXISTS auth_user_sources (
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  canonical_email TEXT NOT NULL DEFAULT '',
  source_status TEXT NOT NULL DEFAULT 'active' CHECK (source_status IN ('active', 'inactive')),
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source, external_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_user_sources_user
  ON auth_user_sources(source, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_user_sources_email
  ON auth_user_sources(source, lower(canonical_email))
  WHERE canonical_email <> '';

CREATE TABLE IF NOT EXISTS auth_department_sources (
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  source_status TEXT NOT NULL DEFAULT 'active' CHECK (source_status IN ('active', 'inactive')),
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source, external_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_department_sources_department
  ON auth_department_sources(source, department_id);

CREATE TABLE IF NOT EXISTS auth_directory_events (
  source TEXT NOT NULL,
  event_key TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('department', 'employee')),
  action TEXT NOT NULL CHECK (action IN ('create', 'deactivate', 'update')),
  external_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'succeeded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source, event_key)
);

CREATE INDEX IF NOT EXISTS idx_auth_directory_events_status
  ON auth_directory_events(source, status, updated_at);

CREATE TABLE IF NOT EXISTS auth_directory_sync_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('department', 'employee', 'directory')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('login_unknown_department', 'manual', 'scheduled', 'webhook')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  seen_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_directory_sync_runs_lookup
  ON auth_directory_sync_runs(source, entity_type, started_at);
