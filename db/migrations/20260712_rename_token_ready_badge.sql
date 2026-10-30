UPDATE portal_badge_definitions
SET
  name_zh = 'Token 就绪',
  name_en = 'Token Ready',
  description_zh = '创建第一个 active Frontier Workspace Token。',
  description_en = 'Create the first active Frontier Workspace Token.',
  updated_at = CURRENT_TIMESTAMP
WHERE badge_key = 'token_ready';
