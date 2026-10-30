-- Frontier Workspace v0.1 fresh-install schema; no enterprise data.
PRAGMA foreign_keys = ON;
CREATE TABLE knowledge_audit_events (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  actor_user_id TEXT,
  namespace_id TEXT,
  object_id TEXT,
  action TEXT NOT NULL,
  decision TEXT CHECK (decision IN ('allow', 'deny') OR decision IS NULL),
  reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE knowledge_change_items (
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

CREATE TABLE knowledge_change_sets (
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
  actor_email TEXT NOT NULL DEFAULT '',
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

CREATE TABLE knowledge_diff_outbox (
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

CREATE TABLE knowledge_feedback (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL
    REFERENCES knowledge_namespaces(id) ON DELETE RESTRICT,
  root_object_id TEXT NOT NULL
    REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  service_id TEXT
    REFERENCES knowledge_services(id) ON DELETE SET NULL,
  object_id TEXT
    REFERENCES knowledge_objects(id) ON DELETE SET NULL,
  change_set_id TEXT
    REFERENCES knowledge_change_sets(id) ON DELETE SET NULL,
  actor_user_id TEXT NOT NULL,
  source_channel TEXT NOT NULL CHECK (
    source_channel IN ('portal', 'mcp', 'api')
  ),
  kind TEXT NOT NULL CHECK (
    kind IN ('question', 'correction', 'issue', 'suggestion')
  ),
  message TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'triaged', 'resolved', 'dismissed')
  ),
  idempotency_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE TABLE knowledge_feedback_query_links (
  feedback_id TEXT PRIMARY KEY
    REFERENCES knowledge_feedback(id) ON DELETE CASCADE,
  query_id TEXT
    REFERENCES knowledge_query_sessions(id) ON DELETE SET NULL,
  query_step_id TEXT
    REFERENCES knowledge_query_steps(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE knowledge_index_chunks (
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

CREATE TABLE knowledge_index_documents (
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

CREATE VIRTUAL TABLE knowledge_index_fts USING fts5(
  text,
  content = 'knowledge_index_chunks',
  content_rowid = 'id',
  tokenize = 'trigram'
);

CREATE TABLE knowledge_index_outbox (
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

CREATE TABLE knowledge_ingestion_states (
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

CREATE TABLE knowledge_mutation_commands (
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

CREATE TABLE knowledge_namespaces (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'workspace',
  owner_user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'team', 'department')),
  name TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  storage_mode TEXT NOT NULL DEFAULT 'shared_bucket' CHECK (storage_mode IN ('shared_bucket', 'department_bucket', 'dedicated_bucket')),
  storage_partition_id TEXT,
  r2_bucket_name TEXT NOT NULL DEFAULT 'workspace-knowledge-objects',
  r2_prefix TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'archived', 'disabled')),
  quota_bytes INTEGER NOT NULL DEFAULT 0,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_user_id, kind, status)
);

CREATE TABLE knowledge_object_versions (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  namespace_id TEXT NOT NULL REFERENCES knowledge_namespaces(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(object_id, version)
);

CREATE TABLE knowledge_objects (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES knowledge_namespaces(id) ON DELETE CASCADE,
  parent_path TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('file', 'folder')),
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  content_kind TEXT NOT NULL DEFAULT 'binary',
  current_version_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL DEFAULT '',
  updated_by_user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE TABLE knowledge_open_tokens (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES knowledge_namespaces(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL DEFAULT 'preview' CHECK (purpose IN ('preview', 'download', 'share_invite')),
  created_by_user_id TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE knowledge_permission_provenance (
  permission_id TEXT PRIMARY KEY
    REFERENCES knowledge_permissions(id) ON DELETE CASCADE,
  grant_source TEXT NOT NULL CHECK (
    grant_source IN ('direct', 'knowledge_service', 'migration', 'system')
  ),
  source_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE knowledge_permissions (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES knowledge_namespaces(id) ON DELETE CASCADE,
  object_id TEXT REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'team', 'department', 'company', 'mcp_client')),
  subject_id TEXT NOT NULL DEFAULT '',
  -- `editor` remains a storage alias for API role `collaborator` during rollout.
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'collaborator', 'owner')),
  can_share INTEGER NOT NULL DEFAULT 0,
  can_publish_skill INTEGER NOT NULL DEFAULT 0,
  granted_by_user_id TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

CREATE TABLE knowledge_query_sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL DEFAULT '',
  client_session_id TEXT NOT NULL DEFAULT '',
  client_turn_id TEXT NOT NULL DEFAULT '',
  original_question_hash TEXT NOT NULL DEFAULT '',
  original_question_text TEXT NOT NULL DEFAULT '',
  raw_question_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE knowledge_query_steps (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL
    REFERENCES knowledge_query_sessions(id) ON DELETE CASCADE,
  parent_step_id TEXT
    REFERENCES knowledge_query_steps(id) ON DELETE SET NULL,
  service_id TEXT
    REFERENCES knowledge_services(id) ON DELETE SET NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('tree', 'glob', 'search', 'grep', 'read')
  ),
  request_id TEXT NOT NULL DEFAULT '',
  query_text_hash TEXT NOT NULL DEFAULT '',
  result_count INTEGER NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  source_revision INTEGER NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
  index_generation INTEGER NOT NULL DEFAULT 0 CHECK (index_generation >= 0),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  status TEXT NOT NULL DEFAULT 'started' CHECK (
    status IN ('started', 'succeeded', 'failed')
  ),
  error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE knowledge_root_owner_transfers (
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

CREATE TABLE knowledge_service_index_state (
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

CREATE TABLE knowledge_service_profiles (
  service_id TEXT PRIMARY KEY
    REFERENCES knowledge_services(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'general',
  tags_json TEXT NOT NULL DEFAULT '[]',
  languages_json TEXT NOT NULL DEFAULT '[]',
  coverage_json TEXT NOT NULL DEFAULT '[]',
  not_for_json TEXT NOT NULL DEFAULT '[]',
  feedback_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (feedback_enabled IN (0, 1)),
  feedback_policy_json TEXT NOT NULL DEFAULT '{}',
  maintenance_team TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE knowledge_service_routing_cards (
  service_id TEXT PRIMARY KEY
    REFERENCES knowledge_services(id) ON DELETE CASCADE,
  role_text TEXT NOT NULL DEFAULT '',
  search_hints_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE knowledge_service_versions (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES knowledge_services(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  handbook_version_id TEXT NOT NULL REFERENCES knowledge_object_versions(id) ON DELETE RESTRICT,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  object_versions_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by_user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(service_id, version)
);

CREATE TABLE knowledge_services (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES knowledge_namespaces(id) ON DELETE CASCADE,
  folder_object_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  handbook_object_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team', 'company', 'public')),
  access_targets_json TEXT NOT NULL DEFAULT '[]',
  update_mode TEXT NOT NULL DEFAULT 'manual' CHECK (update_mode IN ('manual', 'auto')),
  agent_enabled INTEGER NOT NULL DEFAULT 0 CHECK (agent_enabled IN (0, 1)),
  index_status TEXT NOT NULL DEFAULT 'disabled' CHECK (index_status IN ('disabled', 'queued', 'indexing', 'ready', 'stale', 'error')),
  index_generation INTEGER NOT NULL DEFAULT 0,
  source_revision INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(namespace_id, folder_object_id)
);

CREATE TABLE knowledge_shadow_query_reports (
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

CREATE TABLE knowledge_shares (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES knowledge_namespaces(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team', 'company', 'public')),
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'collaborator')),
  token_hash TEXT NOT NULL DEFAULT '',
  passcode_hash TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE knowledge_storage_partitions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'workspace',
  partition_type TEXT NOT NULL DEFAULT 'shared' CHECK (partition_type IN ('shared', 'department', 'regulated')),
  top_department_id TEXT NOT NULL DEFAULT '',
  r2_bucket_name TEXT NOT NULL DEFAULT 'workspace-knowledge-objects',
  r2_prefix TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'archived', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, partition_type, top_department_id)
);

CREATE TABLE knowledge_zip_import_jobs (
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

CREATE INDEX idx_knowledge_audit_created ON knowledge_audit_events(created_at);

CREATE INDEX idx_knowledge_change_items_diff_status
  ON knowledge_change_items(diff_status, created_at);

CREATE INDEX idx_knowledge_change_items_object
  ON knowledge_change_items(object_id, created_at DESC);

CREATE INDEX idx_knowledge_change_items_set
  ON knowledge_change_items(change_set_id, created_at);

CREATE INDEX idx_knowledge_change_sets_actor_created
  ON knowledge_change_sets(actor_user_id, created_at DESC);

CREATE UNIQUE INDEX idx_knowledge_change_sets_mutation
  ON knowledge_change_sets(mutation_command_id)
  WHERE mutation_command_id IS NOT NULL;

CREATE INDEX idx_knowledge_change_sets_root_created
  ON knowledge_change_sets(root_object_id, created_at DESC);

CREATE INDEX idx_knowledge_diff_outbox_pending
  ON knowledge_diff_outbox(status, next_attempt_at, created_at);

CREATE INDEX idx_knowledge_feedback_actor_created
  ON knowledge_feedback(actor_user_id, created_at DESC);

CREATE UNIQUE INDEX idx_knowledge_feedback_idempotency
  ON knowledge_feedback(org_id, actor_user_id, idempotency_key)
  WHERE idempotency_key != '';

CREATE INDEX idx_knowledge_feedback_query_links_query
  ON knowledge_feedback_query_links(query_id, created_at DESC);

CREATE INDEX idx_knowledge_feedback_root_created
  ON knowledge_feedback(root_object_id, created_at DESC);

CREATE INDEX idx_knowledge_feedback_service_status
  ON knowledge_feedback(service_id, status, created_at DESC);

CREATE INDEX idx_knowledge_index_chunks_version
  ON knowledge_index_chunks(service_id, object_id, version_id, chunk_ordinal);

CREATE INDEX idx_knowledge_index_documents_current_lookup
  ON knowledge_index_documents(service_id, object_id, version_id, status);

CREATE INDEX idx_knowledge_index_documents_status
  ON knowledge_index_documents(status, updated_at);

CREATE INDEX idx_knowledge_index_outbox_pending
  ON knowledge_index_outbox(status, next_attempt_at, created_at);

CREATE INDEX idx_knowledge_index_outbox_service_revision
  ON knowledge_index_outbox(service_id, source_revision, created_at);

CREATE INDEX idx_knowledge_ingestion_states_status
  ON knowledge_ingestion_states(scan_status, updated_at);

CREATE INDEX idx_knowledge_mutation_commands_object
  ON knowledge_mutation_commands(namespace_id, object_id, created_at);

CREATE INDEX idx_knowledge_mutation_commands_status
  ON knowledge_mutation_commands(status, created_at);

CREATE INDEX idx_knowledge_namespaces_owner ON knowledge_namespaces(owner_user_id, status);

CREATE INDEX idx_knowledge_objects_path ON knowledge_objects(namespace_id, path, deleted_at);

CREATE INDEX idx_knowledge_objects_tree ON knowledge_objects(namespace_id, parent_path, deleted_at, object_kind, file_name);

CREATE UNIQUE INDEX idx_knowledge_objects_unique_active_path
  ON knowledge_objects(namespace_id, path)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_knowledge_open_tokens_hash ON knowledge_open_tokens(token_hash, expires_at);

CREATE INDEX idx_knowledge_permission_provenance_source
  ON knowledge_permission_provenance(grant_source, source_id);

CREATE UNIQUE INDEX idx_knowledge_permissions_one_active_root_owner
  ON knowledge_permissions(object_id)
  WHERE subject_type = 'user'
    AND role = 'owner'
    AND revoked_at IS NULL;

CREATE INDEX idx_knowledge_permissions_subject ON knowledge_permissions(subject_type, subject_id, revoked_at);

CREATE UNIQUE INDEX idx_knowledge_permissions_unique_active
  ON knowledge_permissions(namespace_id, IFNULL(object_id, ''), subject_type, subject_id)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_knowledge_query_sessions_actor_activity
  ON knowledge_query_sessions(org_id, actor_user_id, last_activity_at DESC);

CREATE INDEX idx_knowledge_query_sessions_client_turn
  ON knowledge_query_sessions(org_id, client_id, client_session_id, client_turn_id)
  WHERE client_turn_id != '';

CREATE INDEX idx_knowledge_query_steps_query_created
  ON knowledge_query_steps(query_id, created_at, id);

CREATE INDEX idx_knowledge_query_steps_service_created
  ON knowledge_query_steps(service_id, created_at DESC);

CREATE UNIQUE INDEX idx_knowledge_root_owner_transfer_pending
  ON knowledge_root_owner_transfers(root_object_id)
  WHERE status = 'pending';

CREATE INDEX idx_knowledge_root_owner_transfer_recipient
  ON knowledge_root_owner_transfers(to_user_id, status, created_at);

CREATE INDEX idx_knowledge_service_profiles_category
  ON knowledge_service_profiles(category, updated_at DESC);

CREATE INDEX idx_knowledge_service_versions_service ON knowledge_service_versions(service_id, status, version);

CREATE INDEX idx_knowledge_services_folder ON knowledge_services(folder_object_id, status);

CREATE INDEX idx_knowledge_shadow_reports_divergent_created
  ON knowledge_shadow_query_reports(divergent, created_at DESC);

CREATE INDEX idx_knowledge_shadow_reports_service_created
  ON knowledge_shadow_query_reports(service_id, created_at DESC);

CREATE INDEX idx_knowledge_shares_object ON knowledge_shares(object_id, revoked_at, visibility);

CREATE UNIQUE INDEX idx_knowledge_shares_one_active_public
  ON knowledge_shares(object_id)
  WHERE visibility = 'public' AND revoked_at IS NULL;

CREATE INDEX idx_knowledge_versions_object ON knowledge_object_versions(object_id, version DESC);

CREATE INDEX idx_knowledge_zip_import_jobs_state_created ON knowledge_zip_import_jobs(state, created_at);

CREATE TRIGGER trg_knowledge_index_chunks_ad
AFTER DELETE ON knowledge_index_chunks
BEGIN
  INSERT INTO knowledge_index_fts(knowledge_index_fts, rowid, text)
  VALUES ('delete', OLD.id, OLD.text);
END;

CREATE TRIGGER trg_knowledge_index_chunks_ai
AFTER INSERT ON knowledge_index_chunks
BEGIN
  INSERT INTO knowledge_index_fts(rowid, text) VALUES (NEW.id, NEW.text);
END;

CREATE TRIGGER trg_knowledge_index_chunks_au
AFTER UPDATE OF text ON knowledge_index_chunks
BEGIN
  INSERT INTO knowledge_index_fts(knowledge_index_fts, rowid, text)
  VALUES ('delete', OLD.id, OLD.text);
  INSERT INTO knowledge_index_fts(rowid, text) VALUES (NEW.id, NEW.text);
END;

CREATE TRIGGER trg_knowledge_permissions_owner_user_insert
BEFORE INSERT ON knowledge_permissions
WHEN NEW.revoked_at IS NULL
  AND NEW.role = 'owner'
  AND NEW.subject_type != 'user'
BEGIN
  SELECT RAISE(ABORT, 'knowledge_owner_subject_must_be_user');
END;

CREATE TRIGGER trg_knowledge_permissions_owner_user_update
BEFORE UPDATE OF role, subject_type, revoked_at ON knowledge_permissions
WHEN NEW.revoked_at IS NULL
  AND NEW.role = 'owner'
  AND NEW.subject_type != 'user'
BEGIN
  SELECT RAISE(ABORT, 'knowledge_owner_subject_must_be_user');
END;

CREATE TRIGGER trg_knowledge_permissions_root_insert
BEFORE INSERT ON knowledge_permissions
WHEN NEW.object_id IS NOT NULL
  AND NEW.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM knowledge_objects AS root
    WHERE root.id = NEW.object_id
      AND root.namespace_id = NEW.namespace_id
      AND root.object_kind = 'folder'
      AND root.parent_path = ''
      AND root.deleted_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'knowledge_acl_root_required');
END;

CREATE TRIGGER trg_knowledge_permissions_root_update
BEFORE UPDATE OF namespace_id, object_id, revoked_at ON knowledge_permissions
WHEN NEW.object_id IS NOT NULL
  AND NEW.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM knowledge_objects AS root
    WHERE root.id = NEW.object_id
      AND root.namespace_id = NEW.namespace_id
      AND root.object_kind = 'folder'
      AND root.parent_path = ''
      AND root.deleted_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'knowledge_acl_root_required');
END;

CREATE TRIGGER trg_knowledge_services_root_insert
BEFORE INSERT ON knowledge_services
WHEN NOT EXISTS (
  SELECT 1
  FROM knowledge_objects AS root
  WHERE root.id = NEW.folder_object_id
    AND root.namespace_id = NEW.namespace_id
    AND root.object_kind = 'folder'
    AND root.parent_path = ''
    AND root.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'knowledge_service_root_required');
END;

CREATE TRIGGER trg_knowledge_services_root_update
BEFORE UPDATE OF namespace_id, folder_object_id ON knowledge_services
WHEN NOT EXISTS (
  SELECT 1
  FROM knowledge_objects AS root
  WHERE root.id = NEW.folder_object_id
    AND root.namespace_id = NEW.namespace_id
    AND root.object_kind = 'folder'
    AND root.parent_path = ''
    AND root.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'knowledge_service_root_required');
END;

CREATE TRIGGER trg_knowledge_zip_import_quota
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
