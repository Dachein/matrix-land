PRAGMA foreign_keys = ON;

-- Memory entries are append-only model-context events. They are private to the
-- authenticated MateUserScope and server-derived Live/Preview namespace.
-- Runtime routes must never accept user_id from a caller.
CREATE TABLE IF NOT EXISTS mate_memory_entries (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('live', 'preview')),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('conversation', 'email_thread', 'task_root')),
  scope_id TEXT NOT NULL,
  id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  parent_entry_id TEXT,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN (
    'user_message', 'assistant_message', 'tool_call', 'tool_result',
    'task_conclusion', 'system_event'
  )),
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, user_id, runtime_mode, scope_kind, scope_id, id),
  UNIQUE (mate_id, user_id, runtime_mode, scope_kind, scope_id, sequence)
);

-- Compaction is a non-destructive read overlay. Original entries are never
-- updated or deleted. A newer iterative overlay supersedes the previous one.
CREATE TABLE IF NOT EXISTS mate_memory_compactions (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('live', 'preview')),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('conversation', 'email_thread', 'task_root')),
  scope_id TEXT NOT NULL,
  id TEXT NOT NULL,
  previous_compaction_id TEXT,
  from_sequence INTEGER NOT NULL CHECK (from_sequence >= 1),
  to_sequence INTEGER NOT NULL CHECK (to_sequence >= from_sequence),
  summary_json TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  summary_digest TEXT NOT NULL,
  source_token_estimate INTEGER NOT NULL CHECK (source_token_estimate >= 0),
  summary_token_estimate INTEGER NOT NULL CHECK (summary_token_estimate >= 0),
  model_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'invalid')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, user_id, runtime_mode, scope_kind, scope_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mate_memory_active_compaction
  ON mate_memory_compactions(mate_id, user_id, runtime_mode, scope_kind, scope_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_mate_memory_entries_scope
  ON mate_memory_entries(
    mate_id, user_id, runtime_mode, scope_kind, scope_id, sequence
  );

CREATE INDEX IF NOT EXISTS idx_mate_memory_compactions_scope
  ON mate_memory_compactions(
    mate_id, user_id, runtime_mode, scope_kind, scope_id, created_at DESC
  );

-- R2 object bodies are addressed only through this user-owned metadata. An R2
-- key is not authority and is never returned as a public download credential.
CREATE TABLE IF NOT EXISTS mate_artifacts (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('live', 'preview')),
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('input', 'generated', 'tool_output')),
  object_key TEXT NOT NULL,
  sha256_digest TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'expired', 'deleted')),
  retention_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, user_id, runtime_mode, id),
  UNIQUE (object_key),
  FOREIGN KEY (mate_id, user_id, runtime_mode, task_id)
    REFERENCES mate_tasks(mate_id, user_id, runtime_mode, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mate_artifacts_task
  ON mate_artifacts(mate_id, user_id, runtime_mode, task_id, created_at);
