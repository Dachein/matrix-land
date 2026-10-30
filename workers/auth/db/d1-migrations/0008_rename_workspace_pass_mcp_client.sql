-- Keep the existing client id for token compatibility; only update its public name.
UPDATE auth_mcp_clients
SET
  name = 'Workspace MCP MCP',
  updated_at = CURRENT_TIMESTAMP
WHERE id = 'workspace-ai-mcp';
