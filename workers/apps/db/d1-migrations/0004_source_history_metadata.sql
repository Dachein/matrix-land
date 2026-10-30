ALTER TABLE apps_app_source_snapshots
ADD COLUMN version_name TEXT NOT NULL DEFAULT '';

ALTER TABLE apps_app_source_snapshots
ADD COLUMN notes TEXT NOT NULL DEFAULT '';

ALTER TABLE apps_app_source_snapshots
ADD COLUMN created_by_name TEXT NOT NULL DEFAULT '';

ALTER TABLE apps_app_source_snapshots
ADD COLUMN upload_context TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE apps_deployments
ADD COLUMN version_name TEXT NOT NULL DEFAULT '';

ALTER TABLE apps_deployments
ADD COLUMN release_notes TEXT NOT NULL DEFAULT '';

ALTER TABLE apps_deployments
ADD COLUMN created_by_name TEXT NOT NULL DEFAULT '';
