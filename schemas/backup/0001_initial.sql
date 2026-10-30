-- Frontier Workspace v0.1 fresh-install schema; no enterprise data.
PRAGMA foreign_keys = ON;
CREATE TABLE "app_backup_policies" (
  app_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  app_name TEXT NOT NULL,
  app_code TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  resource_snapshot_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')) DEFAULT 'weekly',
  schedule_time TEXT NOT NULL CHECK (schedule_time = '00:00') DEFAULT '00:00',
  schedule_timezone TEXT NOT NULL CHECK (schedule_timezone = 'Asia/Hong_Kong') DEFAULT 'Asia/Hong_Kong',
  schedule_weekday INTEGER NOT NULL DEFAULT 1 CHECK (schedule_weekday BETWEEN 0 AND 6),
  schedule_monthday INTEGER NOT NULL DEFAULT 1 CHECK (schedule_monthday BETWEEN 1 AND 31),
  compliance_retention_enabled INTEGER NOT NULL DEFAULT 0 CHECK (compliance_retention_enabled IN (0, 1)),
  compliance_retention_years INTEGER NOT NULL DEFAULT 7 CHECK (compliance_retention_years BETWEEN 1 AND 99),
  backup_node_id TEXT REFERENCES backup_nodes(id) ON DELETE SET NULL,
  local_copy_limit INTEGER NOT NULL DEFAULT 10 CHECK (local_copy_limit = 10),
  next_run_at TEXT,
  last_run_at TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE "backup_artifacts" (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('d1_export', 'r2_object', 'manifest', 'archive')),
  source_resource_id TEXT,
  source_key TEXT,
  artifact_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  checksum TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE backup_audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE backup_deliveries (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES backup_jobs(id) ON DELETE CASCADE,
  backup_node_id TEXT REFERENCES backup_nodes(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting_for_node', 'pending_agent', 'uploading', 'succeeded', 'failed')),
  remote_path TEXT,
  bytes_sent INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE backup_jobs (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  app_name TEXT NOT NULL,
  app_code TEXT NOT NULL,
  org_id TEXT NOT NULL,
  backup_node_id TEXT REFERENCES backup_nodes(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'exporting_d1', 'copying_r2', 'packaging', 'waiting_for_node', 'uploading_sftp', 'verifying', 'succeeded', 'failed', 'cancelled')),
  source_types_json TEXT NOT NULL DEFAULT '[]',
  resource_snapshot_json TEXT NOT NULL DEFAULT '[]',
  artifact_prefix TEXT NOT NULL,
  manifest_key TEXT,
  object_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  retained INTEGER NOT NULL DEFAULT 1,
  current_step TEXT,
  error_code TEXT,
  error_message TEXT,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
, compliance_retention_enabled INTEGER NOT NULL DEFAULT 0 CHECK (compliance_retention_enabled IN (0, 1)), compliance_retention_years INTEGER NOT NULL DEFAULT 7 CHECK (compliance_retention_years BETWEEN 1 AND 99), retain_until TEXT);

CREATE TABLE backup_nodes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('sftp')) DEFAULT 'sftp',
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  username TEXT NOT NULL,
  remote_path TEXT NOT NULL DEFAULT '/backups',
  host_key_fingerprint TEXT NOT NULL DEFAULT '',
  password_cipher_text TEXT,
  password_cipher_iv TEXT,
  password_algorithm TEXT NOT NULL DEFAULT 'AES-GCM',
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')) DEFAULT 'active',
  last_test_status TEXT CHECK (last_test_status IN ('reachable', 'unreachable')),
  last_test_latency_ms INTEGER,
  last_test_error TEXT,
  last_tested_at TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_app_backup_policies_due ON app_backup_policies(enabled, next_run_at);

CREATE INDEX idx_app_backup_policies_node ON app_backup_policies(backup_node_id, enabled);

CREATE INDEX idx_backup_artifacts_job ON backup_artifacts(job_id, kind, created_at);

CREATE INDEX idx_backup_audit_target ON backup_audit_logs(target_type, target_id, created_at);

CREATE INDEX idx_backup_deliveries_status ON backup_deliveries(status, updated_at);

CREATE INDEX idx_backup_jobs_app ON backup_jobs(app_id, created_at DESC);

CREATE INDEX idx_backup_jobs_status ON backup_jobs(status, created_at);

CREATE INDEX idx_backup_nodes_org ON backup_nodes(org_id, status, name);

CREATE UNIQUE INDEX idx_backup_nodes_org_default ON backup_nodes(org_id) WHERE is_default = 1 AND status = 'active';
