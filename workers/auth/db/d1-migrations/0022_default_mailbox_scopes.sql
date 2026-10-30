-- Permit future consent for the built-in desktop client. Do not widen any
-- existing connection, access token, refresh token, or user grant.
UPDATE auth_mcp_clients
SET allowed_scopes_json = json_insert(allowed_scopes_json, '$[#]', 'workspace:mail:read'), updated_at = CURRENT_TIMESTAMP
WHERE id = 'workspace-ai-mcp'
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_scopes_json) WHERE value = 'workspace:mail:read');
UPDATE auth_mcp_clients
SET allowed_scopes_json = json_insert(allowed_scopes_json, '$[#]', 'workspace:mail:write'), updated_at = CURRENT_TIMESTAMP
WHERE id = 'workspace-ai-mcp'
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_scopes_json) WHERE value = 'workspace:mail:write');
