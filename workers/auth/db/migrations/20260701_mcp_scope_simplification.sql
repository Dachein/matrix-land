UPDATE auth_mcp_clients
SET allowed_scopes_json = '["workspace:forum:read","workspace:forum:write","workspace:hub:read","workspace:apps:read","workspace:apps:write"]',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'workspace-ai-mcp';
