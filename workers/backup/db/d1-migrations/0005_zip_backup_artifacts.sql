PRAGMA foreign_keys = OFF;

CREATE TABLE backup_artifacts_zip (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('d1_export', 'r2_object', 'manifest', 'archive')),
  source_resource_id TEXT,
  source_key TEXT,
  artifact_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  checksum TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO backup_artifacts_zip (
  id, job_id, app_id, kind, source_resource_id, source_key,
  artifact_key, content_type, size_bytes, checksum, created_at
)
SELECT
  id, job_id, app_id, kind, source_resource_id, source_key,
  artifact_key, content_type, size_bytes, checksum, created_at
FROM backup_artifacts;

DROP TABLE backup_artifacts;
ALTER TABLE backup_artifacts_zip RENAME TO backup_artifacts;
CREATE INDEX idx_backup_artifacts_job ON backup_artifacts(job_id, kind, created_at);

PRAGMA foreign_keys = ON;
