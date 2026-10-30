ALTER TABLE apps_deployments ADD COLUMN harness_report_url TEXT NOT NULL DEFAULT '';
ALTER TABLE apps_deployments ADD COLUMN harness_self_check_confirmed_at TEXT;
ALTER TABLE apps_deployments ADD COLUMN harness_self_check_confirmed_by TEXT NOT NULL DEFAULT '';
