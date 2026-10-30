CREATE TABLE IF NOT EXISTS knowledge_zip_import_jobs (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES knowledge_namespaces(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  root_path TEXT NOT NULL,
  root_object_id TEXT NOT NULL,
  object_ids_json TEXT NOT NULL DEFAULT '[]',
  staging_prefix TEXT NOT NULL,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  entry_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'staging' CHECK (state IN ('staging', 'committed', 'failed')),
  error_code TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE(namespace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_zip_import_jobs_state_created
ON knowledge_zip_import_jobs(state, created_at);

CREATE TRIGGER IF NOT EXISTS trg_knowledge_zip_import_quota
BEFORE UPDATE OF state ON knowledge_zip_import_jobs
WHEN NEW.state = 'committed'
  AND OLD.state != 'committed'
  AND EXISTS (
    SELECT 1
    FROM knowledge_namespaces
    WHERE knowledge_namespaces.id = NEW.namespace_id
      AND knowledge_namespaces.quota_bytes > 0
      AND knowledge_namespaces.used_bytes + NEW.total_bytes > knowledge_namespaces.quota_bytes
  )
BEGIN
  SELECT RAISE(ABORT, 'knowledge_namespace_quota_exceeded');
END;
