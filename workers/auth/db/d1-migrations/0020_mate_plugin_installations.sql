CREATE TABLE IF NOT EXISTS auth_remote_mcp_installations (
  connection_id TEXT NOT NULL REFERENCES auth_remote_mcp_connections(id),
  mate_id TEXT NOT NULL,
  installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_tested_at TEXT,
  last_error_code TEXT,
  tool_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(connection_id, mate_id)
);
INSERT OR IGNORE INTO auth_remote_mcp_installations(connection_id, mate_id)
SELECT connection_id, mate_id FROM auth_remote_mcp_bindings;
