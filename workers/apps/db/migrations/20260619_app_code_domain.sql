ALTER TABLE apps_apps ADD COLUMN code TEXT NOT NULL DEFAULT '';

UPDATE apps_apps
SET code = slug
WHERE code = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_apps_org_code_unique ON apps_apps(org_id, code);
