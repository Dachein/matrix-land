CREATE TABLE app_backup_policies_v2 (
  app_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  app_name TEXT NOT NULL,
  app_code TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  resource_snapshot_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')) DEFAULT 'weekly',
  schedule_time TEXT NOT NULL DEFAULT '02:00',
  schedule_timezone TEXT NOT NULL CHECK (schedule_timezone = 'Asia/Hong_Kong') DEFAULT 'Asia/Hong_Kong',
  schedule_weekday INTEGER NOT NULL DEFAULT 0 CHECK (schedule_weekday BETWEEN 0 AND 6),
  schedule_monthday INTEGER NOT NULL DEFAULT 1 CHECK (schedule_monthday BETWEEN 1 AND 28),
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

INSERT INTO app_backup_policies_v2 (
  app_id, org_id, app_name, app_code, owner_user_id, resource_snapshot_json,
  enabled, frequency, schedule_time, schedule_timezone, schedule_weekday,
  schedule_monthday, compliance_retention_enabled, compliance_retention_years,
  backup_node_id, local_copy_limit, next_run_at, last_run_at,
  created_by, updated_by, created_at, updated_at
)
SELECT
  app_id, org_id, app_name, app_code, owner_user_id, resource_snapshot_json,
  enabled,
  CASE
    WHEN frequency = 'yearly' THEN 'monthly'
    WHEN frequency IN ('weekly', 'monthly') THEN frequency
    ELSE 'weekly'
  END,
  schedule_time, 'Asia/Hong_Kong', schedule_weekday,
  schedule_monthday, 0, 7,
  backup_node_id, local_copy_limit, next_run_at, last_run_at,
  created_by, updated_by, created_at, updated_at
FROM app_backup_policies;

DROP TABLE app_backup_policies;
ALTER TABLE app_backup_policies_v2 RENAME TO app_backup_policies;

CREATE INDEX idx_app_backup_policies_due ON app_backup_policies(enabled, next_run_at);
CREATE INDEX idx_app_backup_policies_node ON app_backup_policies(backup_node_id, enabled);

ALTER TABLE backup_jobs ADD COLUMN compliance_retention_enabled INTEGER NOT NULL DEFAULT 0 CHECK (compliance_retention_enabled IN (0, 1));
ALTER TABLE backup_jobs ADD COLUMN compliance_retention_years INTEGER NOT NULL DEFAULT 7 CHECK (compliance_retention_years BETWEEN 1 AND 99);
ALTER TABLE backup_jobs ADD COLUMN retain_until TEXT;
