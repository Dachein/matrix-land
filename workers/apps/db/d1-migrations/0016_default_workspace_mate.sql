ALTER TABLE apps_mates ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));

CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_mates_one_default_per_owner
  ON apps_mates(org_id, owner_user_id) WHERE is_default = 1;
