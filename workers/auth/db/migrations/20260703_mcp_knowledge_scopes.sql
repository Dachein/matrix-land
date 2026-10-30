UPDATE auth_mcp_clients
SET allowed_scopes_json = '["workspace:forum:read","workspace:forum:write","workspace:hub:read","workspace:apps:read","workspace:apps:write","workspace:knowledge:read","workspace:knowledge:write","workspace:knowledge:share","workspace:knowledge:skill"]',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'workspace-ai-mcp';

UPDATE auth_mcp_connections
SET scopes_json = '["workspace:forum:read","workspace:forum:write","workspace:hub:read","workspace:apps:read","workspace:apps:write","workspace:knowledge:read","workspace:knowledge:write","workspace:knowledge:share","workspace:knowledge:skill"]',
    updated_at = CURRENT_TIMESTAMP
WHERE client_id = 'workspace-ai-mcp'
  AND status = 'active';

INSERT INTO auth_resource_clients (
  id,
  name,
  status,
  audience,
  access_mode,
  access_targets_json,
  allowed_scopes_json,
  publisher_user_id,
  business_owner_user_id,
  created_at,
  updated_at
)
VALUES (
  'workspace-knowledge',
  'Workspace My Knowledge',
  'listed',
  'https://k.example.invalid',
  'public',
  '[]',
  '["workspace:knowledge:read","workspace:knowledge:write","workspace:knowledge:share","workspace:knowledge:skill"]',
  NULL,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  status = excluded.status,
  audience = excluded.audience,
  access_mode = excluded.access_mode,
  access_targets_json = excluded.access_targets_json,
  allowed_scopes_json = excluded.allowed_scopes_json,
  updated_at = CURRENT_TIMESTAMP;
