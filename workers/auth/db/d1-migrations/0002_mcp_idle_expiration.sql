-- Add the server-authoritative 7-day sliding idle window without rewriting
-- existing connection rows or changing their audit identity.
ALTER TABLE auth_mcp_connections ADD COLUMN idle_expires_at TEXT;
ALTER TABLE auth_mcp_connections ADD COLUMN revoked_reason TEXT;

UPDATE auth_mcp_connections
SET idle_expires_at = datetime(COALESCE(last_seen_at, updated_at, created_at), '+7 days')
WHERE idle_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_auth_mcp_connections_idle
ON auth_mcp_connections(status, idle_expires_at);
