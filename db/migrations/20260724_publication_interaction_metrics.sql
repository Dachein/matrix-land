ALTER TABLE publication_listings
ADD COLUMN agent_add_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE publication_listings
ADD COLUMN zip_download_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE publication_listings
ADD COLUMN visit_count INTEGER NOT NULL DEFAULT 0;

-- Historical Skill usage cannot be split by action because both buttons used
-- the same legacy install_count. Preserve it as Zip downloads so the visible
-- total does not fall after this migration; new events are counted precisely.
UPDATE publication_listings
SET zip_download_count = install_count
WHERE listing_type = 'skill';

-- Portal Apps already have an authoritative launch counter. APPS Apps start at
-- zero because the legacy publication install_count was not an App visit.
UPDATE publication_listings
SET visit_count = COALESCE((
  SELECT app_catalog_metadata.launch_count
  FROM app_catalog_metadata
  WHERE app_catalog_metadata.app_id = publication_listings.target_id
), 0)
WHERE listing_type = 'app'
  AND COALESCE(target_plane, 'portal') = 'portal';

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_target_created
ON audit_logs(action, target_type, target_id, created_at DESC);
