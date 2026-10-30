-- Query paths used by the user breakdown and token-history APIs. The existing
-- user/date index serves all-token reads; these cover a selected token and
-- admin token filters without scanning the whole model ledger.
CREATE INDEX IF NOT EXISTS idx_gateway_usage_daily_model_user_token_date
  ON gateway_usage_daily_model_snapshots(external_user_id, token_id, usage_date);

CREATE INDEX IF NOT EXISTS idx_gateway_usage_daily_model_token_date
  ON gateway_usage_daily_model_snapshots(token_id, usage_date);
