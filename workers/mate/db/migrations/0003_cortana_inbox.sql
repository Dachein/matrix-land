PRAGMA foreign_keys = ON;

-- Private operational records remain partitioned by mateId x userId.
-- Email bodies stay in the corresponding user-owned Task instruction; this
-- table stores only routing and idempotency metadata.
CREATE TABLE IF NOT EXISTS mate_email_threads (
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

CREATE TABLE IF NOT EXISTS mate_email_messages (
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
  created_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, message_digest),
  FOREIGN KEY (mate_id, thread_code)
    REFERENCES mate_email_threads(mate_id, thread_code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mate_todos (
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

CREATE TABLE IF NOT EXISTS mate_reminders (
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
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, user_id, id),
  CHECK (
    (schedule_kind = 'once' AND interval_seconds IS NULL)
    OR (schedule_kind = 'interval' AND interval_seconds >= 300)
  )
);

CREATE TABLE IF NOT EXISTS mate_runtime_cursors (
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cursor_key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, user_id, cursor_key)
);

CREATE TABLE IF NOT EXISTS mate_schedule_executions (
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

CREATE INDEX IF NOT EXISTS idx_mate_email_threads_user_activity
  ON mate_email_threads(mate_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mate_email_messages_user_activity
  ON mate_email_messages(mate_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mate_todos_user_status
  ON mate_todos(mate_id, user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mate_reminders_due
  ON mate_reminders(status, next_due_at, mate_id, user_id);
CREATE INDEX IF NOT EXISTS idx_mate_schedule_executions_reminder
  ON mate_schedule_executions(mate_id, user_id, reminder_id, scheduled_for DESC);
