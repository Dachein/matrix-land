CREATE TABLE IF NOT EXISTS model_gateway_subaccounts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id),
  owner_team_id TEXT REFERENCES teams(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  monthly_budget_units INTEGER NOT NULL DEFAULT 0,
  monthly_used_units INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_team_id, slug)
);

ALTER TABLE model_gateway_tokens ADD COLUMN sub_account_id TEXT REFERENCES model_gateway_subaccounts(id);
ALTER TABLE model_gateway_tokens ADD COLUMN request_limit_per_minute INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_gateway_tokens ADD COLUMN daily_budget_units INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_gateway_tokens ADD COLUMN daily_used_units INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_gateway_usage_events ADD COLUMN sub_account_id TEXT REFERENCES model_gateway_subaccounts(id);

CREATE INDEX IF NOT EXISTS idx_model_gateway_subaccounts_owner ON model_gateway_subaccounts(owner_team_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_model_gateway_tokens_owner ON model_gateway_tokens(owner_team_id, owner_user_id, sub_account_id, status);
CREATE INDEX IF NOT EXISTS idx_model_gateway_usage_subaccount_created ON model_gateway_usage_events(sub_account_id, created_at);
