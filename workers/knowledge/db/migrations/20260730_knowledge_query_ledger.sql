PRAGMA foreign_keys = ON;

-- Agent-facing registration metadata is kept separate from the Service
-- lifecycle row so this migration remains additive and retry-safe. A legacy
-- deployment may already have this table without coverage_json/not_for_json;
-- the guarded profile-compat command adds those columns after this migration.
CREATE TABLE IF NOT EXISTS knowledge_service_profiles (
  service_id TEXT PRIMARY KEY
    REFERENCES knowledge_services(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  languages_json TEXT NOT NULL DEFAULT '[]',
  coverage_json TEXT NOT NULL DEFAULT '[]',
  not_for_json TEXT NOT NULL DEFAULT '[]',
  feedback_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (feedback_enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO knowledge_service_profiles (service_id)
SELECT id FROM knowledge_services;

-- One Query Session groups every Knowledge Service tool call made to answer
-- one user intent. Raw original questions are optional and independently
-- expirable; the hash remains available for deduplication and analytics.
CREATE TABLE IF NOT EXISTS knowledge_query_sessions (
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

CREATE INDEX IF NOT EXISTS idx_knowledge_query_sessions_actor_activity
  ON knowledge_query_sessions(org_id, actor_user_id, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_query_sessions_client_turn
  ON knowledge_query_sessions(org_id, client_id, client_session_id, client_turn_id)
  WHERE client_turn_id != '';

-- Steps form a tree through parent_step_id. They store operational metadata
-- and query hashes, not document bodies or model answers.
CREATE TABLE IF NOT EXISTS knowledge_query_steps (
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

CREATE INDEX IF NOT EXISTS idx_knowledge_query_steps_query_created
  ON knowledge_query_steps(query_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_knowledge_query_steps_service_created
  ON knowledge_query_steps(service_id, created_at DESC);

-- Feedback outlives short-retention Query Ledger rows, so both references are
-- nullable and use ON DELETE SET NULL.
CREATE TABLE IF NOT EXISTS knowledge_feedback_query_links (
  feedback_id TEXT PRIMARY KEY
    REFERENCES knowledge_feedback(id) ON DELETE CASCADE,
  query_id TEXT
    REFERENCES knowledge_query_sessions(id) ON DELETE SET NULL,
  query_step_id TEXT
    REFERENCES knowledge_query_steps(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_knowledge_feedback_query_links_query
  ON knowledge_feedback_query_links(query_id, created_at DESC);
