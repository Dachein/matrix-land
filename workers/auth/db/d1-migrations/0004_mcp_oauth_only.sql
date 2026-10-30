-- All supported MCP hosts now use native OAuth Authorization Code + PKCE.
-- Preserve the host identity on dynamically registered OAuth clients and
-- retire every active connection that was created by the removed device flow.
ALTER TABLE auth_mcp_oauth_clients
ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'codex'
CHECK (agent_type IN ('claude-code', 'codex', 'cursor', 'workbuddy'));

UPDATE auth_mcp_connections
SET status = 'revoked',
    revoked_at = CURRENT_TIMESTAMP,
    revoked_reason = 'oauth_migration_required',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM auth_mcp_authorization_codes oauth_code
    WHERE oauth_code.connection_id = auth_mcp_connections.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM auth_mcp_refresh_tokens oauth_refresh
    WHERE oauth_refresh.connection_id = auth_mcp_connections.id
  );
