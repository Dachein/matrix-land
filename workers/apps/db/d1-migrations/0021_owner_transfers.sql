ALTER TABLE apps_apps ADD COLUMN ownership_sync_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE apps_apps ADD COLUMN ownership_sync_lock_until TEXT;
ALTER TABLE apps_skills ADD COLUMN ownership_sync_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE apps_skills ADD COLUMN ownership_sync_lock_until TEXT;

CREATE TABLE apps_owner_transfers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('app', 'skill')),
  asset_id TEXT NOT NULL,
  asset_name TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  initiated_by_user_id TEXT NOT NULL,
  retain_previous_owner INTEGER NOT NULL CHECK (retain_previous_owner IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired', 'admin_forced')),
  reason TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  decided_by_user_id TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_apps_owner_transfer_pending ON apps_owner_transfers(asset_type, asset_id) WHERE status = 'pending';
CREATE INDEX idx_apps_owner_transfer_inbox ON apps_owner_transfers(org_id, to_user_id, status);
