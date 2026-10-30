CREATE TABLE IF NOT EXISTS gateway_usage_snapshot_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'error')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  source_from_date TEXT NOT NULL,
  source_to_date TEXT NOT NULL,
  data_through_date TEXT NOT NULL,
  source_row_count INTEGER NOT NULL DEFAULT 0,
  attributed_row_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS gateway_usage_daily_snapshots (
  usage_date TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  run_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, external_user_id, token_id)
);

-- Nightly runs write only to these run-scoped staging tables while source
-- collection is in progress. The worker promotes a completed run into the
-- live tables with one transactional D1 batch.
CREATE TABLE IF NOT EXISTS gateway_usage_daily_snapshot_staging (
  run_id TEXT NOT NULL REFERENCES gateway_usage_snapshot_runs(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, usage_date, external_user_id, token_id)
);

CREATE TABLE IF NOT EXISTS gateway_usage_user_snapshot_staging (
  run_id TEXT NOT NULL REFERENCES gateway_usage_snapshot_runs(id) ON DELETE CASCADE,
  external_user_id TEXT NOT NULL,
  monthly_budget_usd REAL,
  PRIMARY KEY (run_id, external_user_id)
);

CREATE TABLE IF NOT EXISTS gateway_usage_user_snapshots (
  external_user_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'error')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  updated_at TEXT NOT NULL,
  data_through_date TEXT NOT NULL,
  cumulative_tokens INTEGER NOT NULL DEFAULT 0,
  peak_daily_tokens INTEGER NOT NULL DEFAULT 0,
  monthly_budget_usd REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_gateway_usage_snapshot_runs_started
  ON gateway_usage_snapshot_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_gateway_usage_daily_user_date
  ON gateway_usage_daily_snapshots(external_user_id, usage_date);
CREATE INDEX IF NOT EXISTS idx_gateway_usage_daily_user_token_date
  ON gateway_usage_daily_snapshots(external_user_id, token_id, usage_date);
