-- Native MCP OAuth lets Codex persist credentials in its configured OAuth
-- store and refresh short-lived access tokens without environment variables.
CREATE TABLE IF NOT EXISTS auth_mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL DEFAULT '',
  redirect_uris_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_mcp_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  oauth_client_id TEXT NOT NULL REFERENCES auth_mcp_oauth_clients(client_id),
  connection_id TEXT NOT NULL REFERENCES auth_mcp_connections(id),
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  resource_url TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_mcp_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  oauth_client_id TEXT NOT NULL REFERENCES auth_mcp_oauth_clients(client_id),
  connection_id TEXT NOT NULL REFERENCES auth_mcp_connections(id),
  user_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  resource_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotated', 'revoked')),
  expires_at TEXT NOT NULL,
  rotated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_mcp_oauth_codes_expiry
ON auth_mcp_authorization_codes(expires_at, consumed_at);
CREATE INDEX IF NOT EXISTS idx_auth_mcp_refresh_connection
ON auth_mcp_refresh_tokens(connection_id, status, expires_at);
