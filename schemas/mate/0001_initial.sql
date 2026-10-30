-- Frontier Workspace v0.1 fresh-install schema; no enterprise data.
PRAGMA foreign_keys = ON;
CREATE TABLE mate_approvals (
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

CREATE TABLE mate_artifacts (
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

CREATE TABLE mate_chat_ingress (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('live', 'preview')),
  conversation_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_instance_name TEXT NOT NULL,
  message_digest TEXT NOT NULL
    CHECK (
      length(message_digest) = 71
      AND substr(message_digest, 1, 7) = 'sha256:'
      AND substr(message_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  environment_digest TEXT NOT NULL
    CHECK (
      length(environment_digest) = 71
      AND substr(environment_digest, 1, 7) = 'sha256:'
      AND substr(environment_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    mate_id,
    user_id,
    runtime_mode,
    conversation_id,
    client_message_id
  ),
  FOREIGN KEY (mate_id, user_id, runtime_mode, conversation_id)
    REFERENCES mate_conversations(mate_id, user_id, runtime_mode, id) ON DELETE CASCADE,
  FOREIGN KEY (mate_id, user_id, runtime_mode, task_id)
    REFERENCES mate_tasks(mate_id, user_id, runtime_mode, id) ON DELETE CASCADE
);

CREATE TABLE mate_conversation_turns (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('live', 'preview')),
  conversation_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  agent_instance_name TEXT NOT NULL,
  message_digest TEXT NOT NULL
    CHECK (
      length(message_digest) = 71
      AND substr(message_digest, 1, 7) = 'sha256:'
      AND substr(message_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  environment_digest TEXT NOT NULL
    CHECK (
      length(environment_digest) = 71
      AND substr(environment_digest, 1, 7) = 'sha256:'
      AND substr(environment_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'completed', 'failed', 'cancelled')),
  assistant_message_id TEXT,
  response_digest TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (mate_id, user_id, runtime_mode, turn_id),
  UNIQUE (
    mate_id,
    user_id,
    runtime_mode,
    conversation_id,
    client_message_id
  ),
  FOREIGN KEY (mate_id, user_id, runtime_mode, conversation_id)
    REFERENCES mate_conversations(mate_id, user_id, runtime_mode, id) ON DELETE CASCADE
);

CREATE TABLE mate_conversations (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('live', 'preview')),
  id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL CHECK (channel IN ('web', 'sdk')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, pinned_at TEXT,
  PRIMARY KEY (mate_id, user_id, runtime_mode, id)
);

CREATE TABLE mate_email_messages (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message_digest TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  thread_code TEXT NOT NULL,
  task_id TEXT,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('accepted', 'replied', 'sent', 'failed')),
  provider_message_id TEXT,
  created_at TEXT NOT NULL, external_message_id TEXT,
  PRIMARY KEY (mate_id, message_digest),
  FOREIGN KEY (mate_id, thread_code)
    REFERENCES mate_email_threads(mate_id, thread_code) ON DELETE CASCADE
);

CREATE TABLE mate_email_threads (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  thread_code TEXT NOT NULL CHECK (length(thread_code) = 4),
  subject TEXT NOT NULL DEFAULT '',
  root_task_id TEXT,
  last_task_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, thread_code),
  UNIQUE (mate_id, user_id, thread_code)
);

CREATE TABLE mate_mail_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  mate_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  subject TEXT NOT NULL,
  received_at TEXT NOT NULL,
  object_key TEXT NOT NULL,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  labels_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, user_id, digest)
);

CREATE TABLE mate_memory_compactions (
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

CREATE TABLE mate_memory_entries (
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

CREATE TABLE mate_preferences (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, user_id)
);

CREATE TABLE mate_reminders (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_task_id TEXT,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once', 'interval')),
  next_due_at TEXT NOT NULL,
  interval_seconds INTEGER,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  thread_code TEXT,
  last_task_id TEXT,
  last_fired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, managed_release_id TEXT, managed_job_id TEXT,
  PRIMARY KEY (mate_id, user_id, id),
  CHECK (
    (schedule_kind = 'once' AND interval_seconds IS NULL)
    OR (schedule_kind = 'interval' AND interval_seconds >= 300)
  )
);

CREATE TABLE mate_runtime_cursors (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cursor_key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, user_id, cursor_key)
);

CREATE TABLE mate_schedule_executions (
  execution_key TEXT PRIMARY KEY,
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reminder_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'failed')),
  task_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE mate_sessions (
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

CREATE TABLE mate_task_events (
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

CREATE TABLE mate_task_runs (
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

CREATE TABLE mate_tasks (
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
  completed_at TEXT, thread_id TEXT,
  PRIMARY KEY (mate_id, user_id, runtime_mode, id),
  FOREIGN KEY (mate_id, user_id, runtime_mode, session_id)
    REFERENCES mate_sessions(mate_id, user_id, runtime_mode, id) ON DELETE CASCADE,
  FOREIGN KEY (mate_id, user_id, runtime_mode, conversation_id)
    REFERENCES mate_conversations(mate_id, user_id, runtime_mode, id) ON DELETE CASCADE,
  FOREIGN KEY (mate_id, user_id, runtime_mode, parent_task_id)
    REFERENCES mate_tasks(mate_id, user_id, runtime_mode, id)
);

CREATE TABLE mate_todos (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_task_id TEXT,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (mate_id, user_id, id)
);

CREATE TABLE mate_tool_audit (
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

CREATE TABLE mate_weixin_bindings (
  id TEXT PRIMARY KEY,
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  channel_account_hash TEXT NOT NULL,
  external_subject_hash TEXT NOT NULL,
  credentials_ciphertext TEXT NOT NULL,
  credentials_iv TEXT NOT NULL,
  active_conversation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  bound_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE mate_weixin_message_receipts (
  binding_id TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed', 'ignored')),
  request_id TEXT NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (binding_id, external_message_id),
  FOREIGN KEY (binding_id) REFERENCES mate_weixin_bindings(id) ON DELETE CASCADE
);

CREATE TABLE mate_weixin_qr_sessions (
  id TEXT PRIMARY KEY,
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'scanned', 'need_verify_code', 'confirmed', 'expired', 'failed'
  )),
  qr_url TEXT NOT NULL,
  qr_ciphertext TEXT NOT NULL,
  qr_iv TEXT NOT NULL,
  verify_code_ciphertext TEXT,
  verify_code_iv TEXT,
  polling_base_url TEXT NOT NULL,
  error_code TEXT,
  binding_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE mate_work_threads (
  id TEXT NOT NULL PRIMARY KEY,
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK(runtime_mode IN ('live','preview')),
  kind TEXT NOT NULL CHECK(kind IN ('task','schedule')),
  thread_code TEXT NOT NULL,
  title TEXT NOT NULL,
  schedule_id TEXT,
  active_task_id TEXT,
  legacy_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(mate_id,runtime_mode,thread_code)
);

CREATE TABLE workspace_mail_app_grants (
  app_id TEXT PRIMARY KEY,org_id TEXT NOT NULL,user_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,
  inbox_id TEXT,sender_id TEXT,receive_enabled INTEGER NOT NULL,send_enabled INTEGER NOT NULL,enabled INTEGER NOT NULL
, trigger_enabled INTEGER NOT NULL DEFAULT 0 CHECK (trigger_enabled IN (0,1)), trigger_enabled_at TEXT);

CREATE TABLE workspace_mail_events (
  message_id TEXT PRIMARY KEY REFERENCES mate_mail_messages(id), org_id TEXT NOT NULL,
  user_id TEXT NOT NULL, mate_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, delivered_at TEXT, last_error TEXT
, app_lease_token TEXT, app_lease_until TEXT);

CREATE TABLE workspace_mail_inbox_runs (
  message_id TEXT PRIMARY KEY, mate_id TEXT NOT NULL, user_id TEXT NOT NULL, org_id TEXT NOT NULL,
  release_id TEXT, manifest_sha256 TEXT, decision_json TEXT,
  task_id TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TEXT, next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workspace_mail_legacy_cleanup(object_key TEXT PRIMARY KEY,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE workspace_mail_mailboxes (
  mate_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
  owner_kind TEXT NOT NULL DEFAULT 'mate',owner_id TEXT,receive_enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'provisioning', routing_rule_id TEXT, last_error TEXT, checked_at TEXT
);

CREATE TABLE workspace_mail_outbound (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, mate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, recipient TEXT NOT NULL,
  subject TEXT NOT NULL, message_id TEXT NOT NULL, provider_id TEXT, status TEXT NOT NULL,
  error TEXT, object_key TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,user_id,mate_id,idempotency_key)
);

CREATE INDEX idx_email_message_reference ON mate_email_messages(mate_id,user_id,external_message_id);

CREATE INDEX idx_mate_approvals_pending
  ON mate_approvals(mate_id, user_id, runtime_mode, status, requested_at DESC);

CREATE INDEX idx_mate_artifacts_task
  ON mate_artifacts(mate_id, user_id, runtime_mode, task_id, created_at);

CREATE INDEX idx_mate_chat_ingress_agent_activity
  ON mate_chat_ingress(
    mate_id, user_id, runtime_mode, agent_instance_name, updated_at DESC
  );

CREATE INDEX idx_mate_chat_ingress_conversation_activity
  ON mate_chat_ingress(
    mate_id, user_id, runtime_mode, conversation_id, updated_at DESC
  );

CREATE INDEX idx_mate_chat_ingress_task
  ON mate_chat_ingress(mate_id, user_id, runtime_mode, task_id);

CREATE INDEX idx_mate_conversation_turns_activity
  ON mate_conversation_turns(
    mate_id, user_id, runtime_mode, conversation_id, updated_at DESC
  );

CREATE INDEX idx_mate_conversation_turns_agent
  ON mate_conversation_turns(
    mate_id, user_id, runtime_mode, agent_instance_name, updated_at DESC
  );

CREATE INDEX idx_mate_conversations_directory
  ON mate_conversations(
    mate_id,
    user_id,
    runtime_mode,
    status,
    pinned_at DESC,
    updated_at DESC
  );

CREATE INDEX idx_mate_conversations_user_activity
  ON mate_conversations(mate_id, user_id, runtime_mode, updated_at DESC);

CREATE INDEX idx_mate_email_messages_user_activity
  ON mate_email_messages(mate_id, user_id, created_at DESC);

CREATE INDEX idx_mate_email_threads_user_activity
  ON mate_email_threads(mate_id, user_id, updated_at DESC);

CREATE UNIQUE INDEX idx_mate_memory_active_compaction
  ON mate_memory_compactions(mate_id, user_id, runtime_mode, scope_kind, scope_id)
  WHERE status = 'active';

CREATE INDEX idx_mate_memory_compactions_scope
  ON mate_memory_compactions(
    mate_id, user_id, runtime_mode, scope_kind, scope_id, created_at DESC
  );

CREATE INDEX idx_mate_memory_entries_scope
  ON mate_memory_entries(
    mate_id, user_id, runtime_mode, scope_kind, scope_id, sequence
  );

CREATE INDEX idx_mate_reminders_due
  ON mate_reminders(status, next_due_at, mate_id, user_id);

CREATE INDEX idx_mate_reminders_managed_job
  ON mate_reminders(mate_id, user_id, managed_job_id, status);

CREATE INDEX idx_mate_schedule_executions_reminder
  ON mate_schedule_executions(mate_id, user_id, reminder_id, scheduled_for DESC);

CREATE INDEX idx_mate_sessions_user_activity
  ON mate_sessions(mate_id, user_id, runtime_mode, created_at DESC);

CREATE INDEX idx_mate_task_runs_attempt
  ON mate_task_runs(mate_id, user_id, runtime_mode, task_id, attempt DESC);

CREATE INDEX idx_mate_tasks_conversation
  ON mate_tasks(mate_id, user_id, runtime_mode, conversation_id, created_at);

CREATE INDEX idx_mate_tasks_user_activity
  ON mate_tasks(mate_id, user_id, runtime_mode, updated_at DESC);

CREATE INDEX idx_mate_todos_user_status
  ON mate_todos(mate_id, user_id, status, updated_at DESC);

CREATE INDEX idx_mate_tool_audit_task
  ON mate_tool_audit(mate_id, user_id, runtime_mode, task_id, created_at DESC);

CREATE UNIQUE INDEX idx_mate_weixin_active_subject
  ON mate_weixin_bindings(external_subject_hash) WHERE status = 'active';

CREATE UNIQUE INDEX idx_mate_weixin_active_user
  ON mate_weixin_bindings(mate_id, user_id) WHERE status = 'active';

CREATE INDEX idx_mate_weixin_qr_expiry
  ON mate_weixin_qr_sessions(expires_at);

CREATE INDEX idx_mate_weixin_qr_user
  ON mate_weixin_qr_sessions(mate_id, user_id, created_at DESC);

CREATE INDEX idx_mate_weixin_receipts_created
  ON mate_weixin_message_receipts(created_at);

CREATE INDEX idx_mate_weixin_status
  ON mate_weixin_bindings(status, updated_at DESC);

CREATE INDEX idx_task_thread ON mate_tasks(mate_id,user_id,runtime_mode,thread_id,created_at DESC);

CREATE INDEX idx_work_thread_activity ON mate_work_threads(mate_id,user_id,runtime_mode,updated_at DESC,id DESC);

CREATE UNIQUE INDEX idx_work_thread_schedule ON mate_work_threads(mate_id,user_id,runtime_mode,schedule_id) WHERE schedule_id IS NOT NULL;

CREATE INDEX mate_mail_owner_page ON mate_mail_messages(org_id, user_id, received_at DESC, id DESC);

CREATE UNIQUE INDEX workspace_mail_default_owner ON workspace_mail_mailboxes(org_id,user_id) WHERE is_default=1 AND owner_kind='mate';

CREATE INDEX workspace_mail_events_due ON workspace_mail_events(next_attempt_at) WHERE delivered_at IS NULL;

CREATE INDEX workspace_mail_events_mailbox_time ON workspace_mail_events(mate_id,next_attempt_at);

CREATE INDEX workspace_mail_inbox_due ON workspace_mail_inbox_runs(next_attempt_at,updated_at) WHERE status IN ('pending','processing','task');

CREATE INDEX workspace_mail_owner ON workspace_mail_mailboxes(org_id,user_id,is_default);

CREATE INDEX workspace_mail_sent_page ON workspace_mail_outbound(org_id,user_id,mate_id,created_at DESC,id DESC);
