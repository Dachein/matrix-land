CREATE TABLE IF NOT EXISTS gateway_usage_daily_model_snapshots (
  usage_date TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  model_group TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'unknown',
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  input_cost_usd REAL NOT NULL DEFAULT 0,
  output_cost_usd REAL NOT NULL DEFAULT 0,
  cache_read_cost_usd REAL NOT NULL DEFAULT 0,
  cache_write_cost_usd REAL NOT NULL DEFAULT 0,
  tool_cost_usd REAL NOT NULL DEFAULT 0,
  original_cost_usd REAL NOT NULL DEFAULT 0,
  discount_usd REAL NOT NULL DEFAULT 0,
  billed_cost_usd REAL NOT NULL DEFAULT 0,
  run_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    usage_date,
    external_user_id,
    token_id,
    model_group,
    upstream_model
  )
);

CREATE TABLE IF NOT EXISTS gateway_usage_daily_model_snapshot_staging (
  run_id TEXT NOT NULL REFERENCES gateway_usage_snapshot_runs(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  model_group TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'unknown',
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  input_cost_usd REAL NOT NULL DEFAULT 0,
  output_cost_usd REAL NOT NULL DEFAULT 0,
  cache_read_cost_usd REAL NOT NULL DEFAULT 0,
  cache_write_cost_usd REAL NOT NULL DEFAULT 0,
  tool_cost_usd REAL NOT NULL DEFAULT 0,
  original_cost_usd REAL NOT NULL DEFAULT 0,
  discount_usd REAL NOT NULL DEFAULT 0,
  billed_cost_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    run_id,
    usage_date,
    external_user_id,
    token_id,
    model_group,
    upstream_model
  )
);

CREATE INDEX IF NOT EXISTS idx_gateway_usage_daily_model_user_date
  ON gateway_usage_daily_model_snapshots(external_user_id, usage_date);

CREATE INDEX IF NOT EXISTS idx_gateway_usage_daily_model_group_date
  ON gateway_usage_daily_model_snapshots(model_group, usage_date);
