export const BACKUP_JOB_INSERT_SQL = `INSERT INTO backup_jobs (
  id, app_id, app_name, app_code, org_id, backup_node_id, trigger_type,
  status, source_types_json, resource_snapshot_json, artifact_prefix,
  compliance_retention_enabled, compliance_retention_years, retain_until,
  requested_by, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
