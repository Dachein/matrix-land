ALTER TABLE apps_deployments ADD COLUMN login_required INTEGER;
ALTER TABLE apps_deployments ADD COLUMN visibility TEXT;
ALTER TABLE apps_deployments ADD COLUMN access_targets_json TEXT;
