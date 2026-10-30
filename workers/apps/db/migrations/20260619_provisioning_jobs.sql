CREATE TABLE IF NOT EXISTS apps_provisioning_jobs (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('create_app', 'deploy_preview', 'publish_production')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0,
  current_step TEXT,
  error_code TEXT,
  error_message TEXT,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS apps_provisioning_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES apps_provisioning_jobs(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  step_key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed', 'skipped')),
  progress INTEGER NOT NULL DEFAULT 0,
  resource_type TEXT,
  resource_id TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_apps_provisioning_jobs_app ON apps_provisioning_jobs(app_id, created_at);
CREATE INDEX IF NOT EXISTS idx_apps_provisioning_jobs_status ON apps_provisioning_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_apps_provisioning_steps_job ON apps_provisioning_steps(job_id, step_order);
