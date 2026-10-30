PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS knowledge_shadow_query_reports (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL
    REFERENCES knowledge_services(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN ('search', 'grep')),
  query_hash TEXT NOT NULL,
  legacy_result_count INTEGER NOT NULL DEFAULT 0 CHECK (legacy_result_count >= 0),
  v2_result_count INTEGER NOT NULL DEFAULT 0 CHECK (v2_result_count >= 0),
  legacy_paths_json TEXT NOT NULL DEFAULT '[]',
  v2_paths_json TEXT NOT NULL DEFAULT '[]',
  divergent INTEGER NOT NULL DEFAULT 0 CHECK (divergent IN (0, 1)),
  stale_leak_detected INTEGER NOT NULL DEFAULT 0 CHECK (stale_leak_detected IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'compared' CHECK (
    status IN ('compared', 'v2_error')
  ),
  error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_knowledge_shadow_reports_service_created
  ON knowledge_shadow_query_reports(service_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_shadow_reports_divergent_created
  ON knowledge_shadow_query_reports(divergent, created_at DESC);

-- Seed one deterministic canonical-index job for every active legacy Service.
-- Retrying this migration never recreates an already-consumed backfill job.
UPDATE knowledge_services
SET source_revision = CASE WHEN source_revision < 1 THEN 1 ELSE source_revision END,
    index_status = CASE WHEN index_status = 'disabled' THEN 'queued' ELSE index_status END,
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'active'
  AND agent_enabled = 1;

INSERT OR IGNORE INTO knowledge_service_index_state (
  service_id, source_revision, indexed_revision, index_generation, status,
  pending_object_count, skipped_object_count, blocked_object_count
)
SELECT
  service.id,
  service.source_revision,
  0,
  service.index_generation,
  'queued',
  0,
  0,
  0
FROM knowledge_services AS service
WHERE service.status = 'active'
  AND service.agent_enabled = 1;

INSERT OR IGNORE INTO knowledge_index_outbox (
  id, service_id, source_revision, object_id, operation, extractor_version,
  payload_hash, status
)
SELECT
  'kidx_backfill_' || service.id,
  service.id,
  service.source_revision,
  service.folder_object_id,
  'backfill',
  'builtin-v1',
  '',
  'pending'
FROM knowledge_services AS service
WHERE service.status = 'active'
  AND service.agent_enabled = 1;
