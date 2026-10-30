-- Explicit new consent. Existing grants and connection tokens are not expanded.
UPDATE auth_mcp_clients SET allowed_scopes_json=json_insert(allowed_scopes_json,'$[#]','workspace:mail:send'),updated_at=CURRENT_TIMESTAMP
WHERE id = 'workspace-ai-mcp'
AND NOT EXISTS (SELECT 1 FROM json_each(allowed_scopes_json) WHERE value='workspace:mail:send');
