PRAGMA foreign_keys = ON;

-- Runtime state is owned by an internal MateUserScope. `runtime_mode` is an
-- execution namespace, not a Workspace and not part of the public identity.
CREATE TABLE IF NOT EXISTS mate_conversations (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('live', 'preview')),
  id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL CHECK (channel IN ('web', 'sdk')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, user_id, runtime_mode, id)
);

-- A Session is one ingress/interaction context. Conversation Web creates one
-- session per turn; Inbox and Owner Test create one session per submitted Task.
CREATE TABLE IF NOT EXISTS mate_sessions (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('live', 'preview')),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('conversation_turn', 'task_ingress', 'owner_test')),
  channel TEXT NOT NULL CHECK (channel IN ('web', 'sdk', 'email', 'mate_call', 'schedule')),
  conversation_id TEXT,
  release_id TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (mate_id, user_id, runtime_mode, id),
  FOREIGN KEY (mate_id, user_id, runtime_mode, conversation_id)
    REFERENCES mate_conversations(mate_id, user_id, runtime_mode, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mate_tasks (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('live', 'preview')),
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  conversation_id TEXT,
  parent_task_id TEXT,
  root_task_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'sdk', 'email', 'mate_call', 'schedule')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'completed', 'failed', 'cancelled')),
  instruction TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  active_run_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  conclusion_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (mate_id, user_id, runtime_mode, id),
  FOREIGN KEY (mate_id, user_id, runtime_mode, session_id)
    REFERENCES mate_sessions(mate_id, user_id, runtime_mode, id) ON DELETE CASCADE,
  FOREIGN KEY (mate_id, user_id, runtime_mode, conversation_id)
    REFERENCES mate_conversations(mate_id, user_id, runtime_mode, id) ON DELETE CASCADE,
  FOREIGN KEY (mate_id, user_id, runtime_mode, parent_task_id)
    REFERENCES mate_tasks(mate_id, user_id, runtime_mode, id)
);

CREATE TABLE IF NOT EXISTS mate_task_runs (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('live', 'preview')),
  task_id TEXT NOT NULL,
  id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting_for_input', 'waiting_for_approval', 'completed', 'failed', 'cancelled')),
  release_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  PRIMARY KEY (mate_id, user_id, runtime_mode, task_id, id),
  UNIQUE (mate_id, user_id, runtime_mode, task_id, attempt),
  FOREIGN KEY (mate_id, user_id, runtime_mode, task_id)
    REFERENCES mate_tasks(mate_id, user_id, runtime_mode, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mate_task_events (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('live', 'preview')),
  task_id TEXT NOT NULL,
  run_id TEXT,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, user_id, runtime_mode, task_id, sequence),
  FOREIGN KEY (mate_id, user_id, runtime_mode, task_id)
    REFERENCES mate_tasks(mate_id, user_id, runtime_mode, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mate_preferences (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, user_id)
);

CREATE TABLE IF NOT EXISTS mate_approvals (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('live', 'preview')),
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  action_digest TEXT NOT NULL,
  release_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  tool_definition_version TEXT NOT NULL,
  policy_version TEXT,
  operation_json TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decision_token TEXT,
  consumed_at TEXT,
  consumption_token TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, user_id, runtime_mode, id),
  FOREIGN KEY (mate_id, user_id, runtime_mode, task_id)
    REFERENCES mate_tasks(mate_id, user_id, runtime_mode, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mate_tool_audit (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('live', 'preview')),
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  approval_id TEXT,
  release_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  result_digest TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (mate_id, user_id, runtime_mode, id),
  FOREIGN KEY (mate_id, user_id, runtime_mode, task_id)
    REFERENCES mate_tasks(mate_id, user_id, runtime_mode, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mate_conversations_user_activity
  ON mate_conversations(mate_id, user_id, runtime_mode, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mate_sessions_user_activity
  ON mate_sessions(mate_id, user_id, runtime_mode, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mate_tasks_user_activity
  ON mate_tasks(mate_id, user_id, runtime_mode, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mate_tasks_conversation
  ON mate_tasks(mate_id, user_id, runtime_mode, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mate_task_runs_attempt
  ON mate_task_runs(mate_id, user_id, runtime_mode, task_id, attempt DESC);
CREATE INDEX IF NOT EXISTS idx_mate_approvals_pending
  ON mate_approvals(mate_id, user_id, runtime_mode, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_mate_tool_audit_task
  ON mate_tool_audit(mate_id, user_id, runtime_mode, task_id, created_at DESC);
