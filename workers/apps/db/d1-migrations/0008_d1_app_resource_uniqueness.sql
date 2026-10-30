-- A APPS App may bind at most one D1 database in each environment, and one
-- provisioned Cloudflare D1 resource ID may belong to only one App. Historical
-- conflicts must be reviewed manually: this migration intentionally fails
-- closed instead of deleting or merging resource records.
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_resources_app_d1_unique
  ON apps_app_resources(app_id, environment)
  WHERE type = 'd1_database';

CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_resources_d1_resource_id_unique
  ON apps_app_resources(resource_id)
  WHERE type = 'd1_database' AND resource_id IS NOT NULL AND resource_id <> '';
