PRAGMA foreign_keys = ON;

-- AIChatAgent Durable Objects are the only source of truth for transcript
-- bodies. D1 keeps only the conversation directory and the idempotent mapping
-- from one client message to its Runtime Task / Agent instance projection.
CREATE TABLE IF NOT EXISTS mate_chat_ingress (
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

CREATE INDEX IF NOT EXISTS idx_mate_chat_ingress_task
  ON mate_chat_ingress(mate_id, user_id, runtime_mode, task_id);

CREATE INDEX IF NOT EXISTS idx_mate_chat_ingress_conversation_activity
  ON mate_chat_ingress(
    mate_id, user_id, runtime_mode, conversation_id, updated_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_mate_chat_ingress_agent_activity
  ON mate_chat_ingress(
    mate_id, user_id, runtime_mode, agent_instance_name, updated_at DESC
  );
