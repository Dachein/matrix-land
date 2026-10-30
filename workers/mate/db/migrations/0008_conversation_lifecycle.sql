PRAGMA foreign_keys = ON;

-- Pinning is directory metadata. Transcript bodies remain authoritative in the
-- conversation Agent Durable Object.
ALTER TABLE mate_conversations ADD COLUMN pinned_at TEXT;

CREATE INDEX IF NOT EXISTS idx_mate_conversations_directory
  ON mate_conversations(
    mate_id,
    user_id,
    runtime_mode,
    status,
    pinned_at DESC,
    updated_at DESC
  );
