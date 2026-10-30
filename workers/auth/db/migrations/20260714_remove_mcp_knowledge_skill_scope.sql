UPDATE auth_mcp_clients
SET allowed_scopes_json = (
      SELECT json_group_array(value)
      FROM json_each(auth_mcp_clients.allowed_scopes_json)
      WHERE value NOT IN ('workspace:knowledge:skill', 'workspace:knowledge:admin')
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'workspace-ai-mcp'
  AND EXISTS (
    SELECT 1 FROM json_each(auth_mcp_clients.allowed_scopes_json)
    WHERE value IN ('workspace:knowledge:skill', 'workspace:knowledge:admin')
  );

UPDATE auth_mcp_device_codes
SET requested_scopes_json = (
      SELECT json_group_array(value)
      FROM json_each(auth_mcp_device_codes.requested_scopes_json)
      WHERE value NOT IN ('workspace:knowledge:skill', 'workspace:knowledge:admin')
    )
WHERE client_id = 'workspace-ai-mcp'
  AND EXISTS (
    SELECT 1 FROM json_each(auth_mcp_device_codes.requested_scopes_json)
    WHERE value IN ('workspace:knowledge:skill', 'workspace:knowledge:admin')
  );

UPDATE auth_mcp_connections
SET scopes_json = (
      SELECT json_group_array(value)
      FROM json_each(auth_mcp_connections.scopes_json)
      WHERE value NOT IN ('workspace:knowledge:skill', 'workspace:knowledge:admin')
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE client_id = 'workspace-ai-mcp'
  AND EXISTS (
    SELECT 1 FROM json_each(auth_mcp_connections.scopes_json)
    WHERE value IN ('workspace:knowledge:skill', 'workspace:knowledge:admin')
  );

UPDATE auth_resource_clients
SET allowed_scopes_json = (
      SELECT json_group_array(value)
      FROM json_each(auth_resource_clients.allowed_scopes_json)
      WHERE value != 'workspace:knowledge:skill'
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'workspace-knowledge'
  AND EXISTS (
    SELECT 1 FROM json_each(auth_resource_clients.allowed_scopes_json)
    WHERE value = 'workspace:knowledge:skill'
  );
