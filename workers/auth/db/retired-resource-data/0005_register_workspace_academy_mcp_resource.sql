-- Register the Resource for the pre-Manifest Workspace Academy deployment.
-- Subsequent publications keep this record synchronized through apps-worker.
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
  'app-mcp:app_83c1296c08eb',
  'Workspace Academy',
  'listed',
  'https://workspace-academy.example.invalid',
  'public',
  '[]',
  '["app:mcp:discover","academy:read","academy:write","academy:admin"]',
  '52d4ad25-1fa7-4e63-91cb-44fa1c75eac2',
  '52d4ad25-1fa7-4e63-91cb-44fa1c75eac2',
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
  publisher_user_id = excluded.publisher_user_id,
  business_owner_user_id = excluded.business_owner_user_id,
  updated_at = CURRENT_TIMESTAMP;
