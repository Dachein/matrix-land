CREATE TABLE IF NOT EXISTS auth_remote_mcp_connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES auth_users(id),
  name TEXT NOT NULL,
  server_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('disconnected','connecting','connected','needs_reauth')),
  generation INTEGER NOT NULL DEFAULT 0,
  credential_ciphertext TEXT,
  credential_expires_at INTEGER NOT NULL DEFAULT 0,
  refresh_lease_until INTEGER NOT NULL DEFAULT 0,
  connected_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,user_id,server_url)
);
CREATE TABLE IF NOT EXISTS auth_remote_mcp_states (
  state_hash TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES auth_remote_mcp_connections(id),
  user_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  context_ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_remote_mcp_bindings (
  connection_id TEXT NOT NULL REFERENCES auth_remote_mcp_connections(id),
  mate_id TEXT NOT NULL,
  approved_tools_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(connection_id,mate_id)
);
