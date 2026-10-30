-- Additive Knowledge Service V2 foundation.
--
-- This migration intentionally does not change runtime authorization or the
-- existing knowledge_permissions table. It adds the durable records required
-- for Root ownership provenance, CAS/idempotency, Change Audit, Diff jobs,
-- incremental indexing, and ingestion safety. Existing code can continue to
-- run before V2 feature flags are enabled.
--
-- Every statement is idempotent so an operator can safely retry the file after
-- losing a Wrangler response.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS knowledge_permission_provenance (
  permission_id TEXT PRIMARY KEY
    REFERENCES knowledge_permissions(id) ON DELETE CASCADE,
  grant_source TEXT NOT NULL CHECK (
    grant_source IN ('direct', 'knowledge_service', 'migration', 'system')
  ),
  source_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_knowledge_permission_provenance_source
  ON knowledge_permission_provenance(grant_source, source_id);

CREATE TABLE IF NOT EXISTS knowledge_root_owner_transfers (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL
    REFERENCES knowledge_namespaces(id) ON DELETE RESTRICT,
  root_object_id TEXT NOT NULL
    REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'accepted', 'rejected', 'expired', 'cancelled', 'admin_forced')
  ),
  initiated_by_user_id TEXT NOT NULL,
  retain_previous_owner INTEGER NOT NULL DEFAULT 1 CHECK (
    retain_previous_owner IN (0, 1)
  ),
  decided_by_user_id TEXT NOT NULL DEFAULT '',
  decision_reason TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_root_owner_transfer_pending
  ON knowledge_root_owner_transfers(root_object_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_knowledge_root_owner_transfer_recipient
  ON knowledge_root_owner_transfers(to_user_id, status, created_at);

CREATE TABLE IF NOT EXISTS knowledge_mutation_commands (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL
    REFERENCES knowledge_namespaces(id) ON DELETE RESTRICT,
  root_object_id TEXT NOT NULL
    REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL,
  expected_version_id TEXT NOT NULL DEFAULT '',
  version_after_id TEXT NOT NULL DEFAULT '',
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (
    status IN ('prepared', 'committed', 'failed')
  ),
  result_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  committed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(idempotency_scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_mutation_commands_object
  ON knowledge_mutation_commands(namespace_id, object_id, created_at);

CREATE INDEX IF NOT EXISTS idx_knowledge_mutation_commands_status
  ON knowledge_mutation_commands(status, created_at);

CREATE TABLE IF NOT EXISTS knowledge_change_sets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL
    REFERENCES knowledge_namespaces(id) ON DELETE RESTRICT,
  root_object_id TEXT NOT NULL
    REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  mutation_command_id TEXT
    REFERENCES knowledge_mutation_commands(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL DEFAULT '',
  idempotency_scope TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL CHECK (
    actor_type IN ('user', 'agent', 'system')
  ),
  actor_user_id TEXT NOT NULL DEFAULT '',
  actor_connection_id TEXT NOT NULL DEFAULT '',
  actor_agent_type TEXT NOT NULL DEFAULT '',
  actor_client_id TEXT NOT NULL DEFAULT '',
  source_channel TEXT NOT NULL CHECK (
    source_channel IN ('portal', 'mcp', 'api', 'zip', 'sync', 'system')
  ),
  operation TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_change_sets_mutation
  ON knowledge_change_sets(mutation_command_id)
  WHERE mutation_command_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_change_sets_root_created
  ON knowledge_change_sets(root_object_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_change_sets_actor_created
  ON knowledge_change_sets(actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_change_items (
  id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL
    REFERENCES knowledge_change_sets(id) ON DELETE RESTRICT,
  root_object_id TEXT NOT NULL
    REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL
    REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (
    action IN (
      'create', 'update', 'edit', 'rename', 'move', 'delete', 'restore',
      'folder_create', 'folder_rename', 'folder_move', 'folder_delete',
      'zip_import'
    )
  ),
  edit_operation TEXT NOT NULL DEFAULT '',
  path_before TEXT NOT NULL DEFAULT '',
  path_after TEXT NOT NULL DEFAULT '',
  version_before_id TEXT NOT NULL DEFAULT '',
  version_after_id TEXT NOT NULL DEFAULT '',
  sha256_before TEXT NOT NULL DEFAULT '',
  sha256_after TEXT NOT NULL DEFAULT '',
  size_before INTEGER NOT NULL DEFAULT 0 CHECK (size_before >= 0),
  size_after INTEGER NOT NULL DEFAULT 0 CHECK (size_after >= 0),
  mime_type_before TEXT NOT NULL DEFAULT '',
  mime_type_after TEXT NOT NULL DEFAULT '',
  expected_version_id TEXT NOT NULL DEFAULT '',
  forced INTEGER NOT NULL DEFAULT 0 CHECK (forced IN (0, 1)),
  diff_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    diff_status IN ('pending', 'ready', 'not_applicable', 'failed')
  ),
  diff_format TEXT NOT NULL DEFAULT 'unified',
  diff_r2_key TEXT NOT NULL DEFAULT '',
  diff_sha256 TEXT NOT NULL DEFAULT '',
  diff_size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (diff_size_bytes >= 0),
  diff_original_size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (diff_original_size_bytes >= 0),
  diff_line_count INTEGER NOT NULL DEFAULT 0 CHECK (diff_line_count >= 0),
  diff_generator_version TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_knowledge_change_items_set
  ON knowledge_change_items(change_set_id, created_at);

CREATE INDEX IF NOT EXISTS idx_knowledge_change_items_object
  ON knowledge_change_items(object_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_change_items_diff_status
  ON knowledge_change_items(diff_status, created_at);

CREATE TABLE IF NOT EXISTS knowledge_diff_outbox (
  id TEXT PRIMARY KEY,
  change_item_id TEXT NOT NULL
    REFERENCES knowledge_change_items(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'dispatching', 'dispatched', 'completed', 'failed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE(change_item_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_diff_outbox_pending
  ON knowledge_diff_outbox(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS knowledge_service_index_state (
  service_id TEXT PRIMARY KEY
    REFERENCES knowledge_services(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
  indexed_revision INTEGER NOT NULL DEFAULT 0 CHECK (indexed_revision >= 0),
  index_generation INTEGER NOT NULL DEFAULT 0 CHECK (index_generation >= 0),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('disabled', 'queued', 'indexing', 'partial', 'ready', 'error')
  ),
  pending_object_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_object_count >= 0),
  skipped_object_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_object_count >= 0),
  blocked_object_count INTEGER NOT NULL DEFAULT 0 CHECK (blocked_object_count >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  indexed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS knowledge_index_documents (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL
    REFERENCES knowledge_services(id) ON DELETE CASCADE,
  root_object_id TEXT NOT NULL
    REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL
    REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL
    REFERENCES knowledge_object_versions(id) ON DELETE RESTRICT,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  language TEXT NOT NULL DEFAULT '',
  extractor_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'extracting', 'ready', 'skipped', 'blocked', 'error', 'superseded')
  ),
  reason_code TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  indexed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(service_id, object_id, version_id, extractor_version)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_index_documents_current_lookup
  ON knowledge_index_documents(service_id, object_id, version_id, status);

CREATE INDEX IF NOT EXISTS idx_knowledge_index_documents_status
  ON knowledge_index_documents(status, updated_at);

CREATE TABLE IF NOT EXISTS knowledge_index_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL
    REFERENCES knowledge_index_documents(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL
    REFERENCES knowledge_services(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL
    REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL
    REFERENCES knowledge_object_versions(id) ON DELETE RESTRICT,
  chunk_ordinal INTEGER NOT NULL CHECK (chunk_ordinal >= 0),
  relative_path_cache TEXT NOT NULL DEFAULT '',
  start_line INTEGER NOT NULL DEFAULT 0 CHECK (start_line >= 0),
  end_line INTEGER NOT NULL DEFAULT 0 CHECK (end_line >= 0),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(document_id, chunk_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_index_chunks_version
  ON knowledge_index_chunks(service_id, object_id, version_id, chunk_ordinal);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_index_fts USING fts5(
  text,
  content = 'knowledge_index_chunks',
  content_rowid = 'id',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS trg_knowledge_index_chunks_ai
AFTER INSERT ON knowledge_index_chunks
BEGIN
  INSERT INTO knowledge_index_fts(rowid, text) VALUES (NEW.id, NEW.text);
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_index_chunks_ad
AFTER DELETE ON knowledge_index_chunks
BEGIN
  INSERT INTO knowledge_index_fts(knowledge_index_fts, rowid, text)
  VALUES ('delete', OLD.id, OLD.text);
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_index_chunks_au
AFTER UPDATE OF text ON knowledge_index_chunks
BEGIN
  INSERT INTO knowledge_index_fts(knowledge_index_fts, rowid, text)
  VALUES ('delete', OLD.id, OLD.text);
  INSERT INTO knowledge_index_fts(rowid, text) VALUES (NEW.id, NEW.text);
END;

CREATE TABLE IF NOT EXISTS knowledge_index_outbox (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL
    REFERENCES knowledge_services(id) ON DELETE CASCADE,
  change_set_id TEXT
    REFERENCES knowledge_change_sets(id) ON DELETE RESTRICT,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  object_id TEXT NOT NULL
    REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL CHECK (
    operation IN ('upsert', 'delete', 'rename', 'backfill', 'reextract')
  ),
  extractor_version TEXT NOT NULL,
  payload_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'dispatching', 'dispatched', 'completed', 'failed', 'superseded')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_knowledge_index_outbox_pending
  ON knowledge_index_outbox(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_knowledge_index_outbox_service_revision
  ON knowledge_index_outbox(service_id, source_revision, created_at);

CREATE TABLE IF NOT EXISTS knowledge_ingestion_states (
  object_id TEXT NOT NULL
    REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL
    REFERENCES knowledge_object_versions(id) ON DELETE RESTRICT,
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    scan_status IN ('pending', 'clean', 'blocked', 'error')
  ),
  scanner_version TEXT NOT NULL DEFAULT '',
  reason_code TEXT NOT NULL DEFAULT '',
  scanned_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(object_id, version_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_ingestion_states_status
  ON knowledge_ingestion_states(scan_status, updated_at);
