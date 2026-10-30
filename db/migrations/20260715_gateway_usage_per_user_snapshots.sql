-- Per-user canonical usage snapshots. Legacy global runs remain readable with
-- a NULL external_user_id; all new manual/scheduled runs are user-scoped.
ALTER TABLE gateway_usage_snapshot_runs ADD COLUMN external_user_id TEXT;
ALTER TABLE gateway_usage_snapshot_runs ADD COLUMN trigger_type TEXT;
ALTER TABLE gateway_usage_snapshot_runs ADD COLUMN data_through_at TEXT;
ALTER TABLE gateway_usage_snapshot_runs ADD COLUMN activity_watermark_at TEXT;
ALTER TABLE gateway_usage_snapshot_runs ADD COLUMN keyset_fingerprint TEXT;

ALTER TABLE gateway_usage_user_snapshots ADD COLUMN data_through_at TEXT;
ALTER TABLE gateway_usage_user_snapshots ADD COLUMN last_checked_at TEXT;
ALTER TABLE gateway_usage_user_snapshots ADD COLUMN activity_watermark_at TEXT;
ALTER TABLE gateway_usage_user_snapshots ADD COLUMN last_reconciled_at TEXT;
ALTER TABLE gateway_usage_user_snapshots ADD COLUMN keyset_fingerprint TEXT;
ALTER TABLE gateway_usage_user_snapshots ADD COLUMN trigger_type TEXT;

-- A date-only legacy snapshot represented a complete Asia/Shanghai day.
-- Shanghai midnight is 16:00 UTC on the preceding UTC date, so the precise
-- end-of-day watermark is 15:59:59.999Z for the stored local date.
UPDATE gateway_usage_snapshot_runs
SET data_through_at = data_through_date || 'T15:59:59.999Z',
    trigger_type = 'scheduled'
WHERE data_through_at IS NULL;

UPDATE gateway_usage_user_snapshots
SET data_through_at = data_through_date || 'T15:59:59.999Z',
    last_checked_at = updated_at,
    last_reconciled_at = updated_at,
    trigger_type = 'scheduled'
WHERE data_through_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_gateway_usage_snapshot_runs_user_started
  ON gateway_usage_snapshot_runs(external_user_id, started_at DESC);

-- D1 serializes writes, and this partial unique index is the final backstop
-- against two non-expired refreshes running for the same user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_usage_snapshot_runs_user_running
  ON gateway_usage_snapshot_runs(external_user_id)
  WHERE external_user_id IS NOT NULL AND status = 'running';
