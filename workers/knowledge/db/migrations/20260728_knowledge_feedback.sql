PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS knowledge_feedback (
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

CREATE INDEX IF NOT EXISTS idx_knowledge_feedback_root_created
  ON knowledge_feedback(root_object_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_feedback_service_status
  ON knowledge_feedback(service_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_feedback_actor_created
  ON knowledge_feedback(actor_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_feedback_idempotency
  ON knowledge_feedback(org_id, actor_user_id, idempotency_key)
  WHERE idempotency_key != '';
