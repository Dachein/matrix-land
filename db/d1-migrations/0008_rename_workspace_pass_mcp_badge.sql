-- Keep existing journey badges intact while updating the public MCP product name.
UPDATE portal_badge_definitions
SET
  description_zh = '完成 Workspace MCP MCP 授权或安装确认。',
  description_en = 'Authorize or confirm the Workspace MCP MCP connection.',
  updated_at = CURRENT_TIMESTAMP
WHERE badge_key = 'mcp_connected';
