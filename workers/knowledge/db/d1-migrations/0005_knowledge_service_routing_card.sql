CREATE TABLE IF NOT EXISTS knowledge_service_routing_cards (
  service_id TEXT PRIMARY KEY
    REFERENCES knowledge_services(id) ON DELETE CASCADE,
  role_text TEXT NOT NULL DEFAULT '',
  search_hints_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
