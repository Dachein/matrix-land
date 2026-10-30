PRAGMA foreign_keys = ON;

-- Conversation turns are not Runtime Tasks. The Agent Durable Object remains
-- authoritative for message bodies; D1 keeps only a metadata projection used
-- for discovery, idempotence and cross-instance operational visibility.
CREATE TABLE IF NOT EXISTS mate_conversation_turns (
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

CREATE INDEX IF NOT EXISTS idx_mate_conversation_turns_activity
  ON mate_conversation_turns(
    mate_id, user_id, runtime_mode, conversation_id, updated_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_mate_conversation_turns_agent
  ON mate_conversation_turns(
    mate_id, user_id, runtime_mode, agent_instance_name, updated_at DESC
  );
