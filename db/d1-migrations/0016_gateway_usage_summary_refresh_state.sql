CREATE TABLE IF NOT EXISTS gateway_usage_summary_refresh_state (
  external_user_id TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL
);
