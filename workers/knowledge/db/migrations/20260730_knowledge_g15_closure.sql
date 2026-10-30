-- G1.5 Knowledge Service discovery metadata.
-- A side table keeps this migration retry-safe on SQLite/D1.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS knowledge_service_profiles (
  service_id TEXT PRIMARY KEY
    REFERENCES knowledge_services(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'general',
  tags_json TEXT NOT NULL DEFAULT '[]',
  languages_json TEXT NOT NULL DEFAULT '[]',
  feedback_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (feedback_enabled IN (0, 1)),
  feedback_policy_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_knowledge_service_profiles_category
  ON knowledge_service_profiles(category, updated_at DESC);

INSERT OR IGNORE INTO knowledge_service_profiles (service_id)
SELECT id FROM knowledge_services;
