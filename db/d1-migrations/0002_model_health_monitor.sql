CREATE TABLE IF NOT EXISTS model_health_runs (
  id TEXT PRIMARY KEY,
  scheduled_at TEXT NOT NULL UNIQUE,
  slot_local TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  status TEXT NOT NULL CHECK (status IN ('running', 'operational', 'degraded', 'outage', 'error')),
  model_count INTEGER NOT NULL DEFAULT 0,
  operational_count INTEGER NOT NULL DEFAULT 0,
  degraded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS model_health_results (
  run_id TEXT NOT NULL REFERENCES model_health_runs(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('operational', 'degraded', 'failed')),
  latency_ms INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  response_excerpt TEXT NOT NULL DEFAULT '',
  tested_at TEXT NOT NULL,
  PRIMARY KEY (run_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_model_health_runs_scheduled
ON model_health_runs(scheduled_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_health_results_model_run
ON model_health_results(model_id, run_id);
