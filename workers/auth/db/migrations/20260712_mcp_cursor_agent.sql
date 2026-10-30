PRAGMA foreign_keys = off;

BEGIN TRANSACTION;

UPDATE auth_mcp_clients
SET supported_agents_json = '["claude-code","codex","workbuddy","cursor"]',
    updated_at = CURRENT_TIMESTAMP
WHERE supported_agents_json = '["claude-code","codex","workbuddy"]'
   OR id = 'workspace-ai-mcp';

CREATE TABLE auth_mcp_device_codes_next (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES auth_mcp_clients(id),
  agent_type TEXT NOT NULL CHECK (agent_type IN ('claude-code', 'codex', 'workbuddy', 'cursor')),
  display_name TEXT NOT NULL DEFAULT '',
  resource_url TEXT NOT NULL DEFAULT '',
  requested_scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
  user_id TEXT,
  user_email TEXT,
  user_name TEXT,
  user_role TEXT,
  user_team TEXT,
  user_department TEXT,
  connection_id TEXT,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO auth_mcp_device_codes_next (
  device_code,
  user_code,
  client_id,
  agent_type,
  display_name,
  resource_url,
  requested_scopes_json,
  status,
  user_id,
  user_email,
  user_name,
  user_role,
  user_team,
  user_department,
  connection_id,
  expires_at,
  approved_at,
  consumed_at,
  created_at
)
SELECT
  device_code,
  user_code,
  client_id,
  agent_type,
  display_name,
  resource_url,
  requested_scopes_json,
  status,
  user_id,
  user_email,
  user_name,
  user_role,
  user_team,
  user_department,
  connection_id,
  expires_at,
  approved_at,
  consumed_at,
  created_at
FROM auth_mcp_device_codes;

DROP TABLE auth_mcp_device_codes;
ALTER TABLE auth_mcp_device_codes_next RENAME TO auth_mcp_device_codes;

CREATE TABLE auth_mcp_connections_next (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES auth_mcp_clients(id),
  user_id TEXT NOT NULL,
  agent_type TEXT NOT NULL CHECK (agent_type IN ('claude-code', 'codex', 'workbuddy', 'cursor')),
  display_name TEXT NOT NULL DEFAULT '',
  resource_url TEXT NOT NULL DEFAULT '',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

INSERT INTO auth_mcp_connections_next (
  id,
  client_id,
  user_id,
  agent_type,
  display_name,
  resource_url,
  scopes_json,
  status,
  last_seen_at,
  created_at,
  updated_at,
  revoked_at
)
SELECT
  id,
  client_id,
  user_id,
  agent_type,
  display_name,
  resource_url,
  scopes_json,
  status,
  last_seen_at,
  created_at,
  updated_at,
  revoked_at
FROM auth_mcp_connections;

DROP TABLE auth_mcp_connections;
ALTER TABLE auth_mcp_connections_next RENAME TO auth_mcp_connections;

COMMIT;

PRAGMA foreign_keys = on;

CREATE INDEX IF NOT EXISTS idx_auth_mcp_device_codes_user_code ON auth_mcp_device_codes(user_code, status);
CREATE INDEX IF NOT EXISTS idx_auth_mcp_device_codes_device_code ON auth_mcp_device_codes(device_code, status);
CREATE INDEX IF NOT EXISTS idx_auth_mcp_connections_user ON auth_mcp_connections(user_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_auth_mcp_connections_client ON auth_mcp_connections(client_id, status, updated_at);
