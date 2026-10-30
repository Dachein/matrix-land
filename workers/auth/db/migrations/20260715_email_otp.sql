CREATE TABLE IF NOT EXISTS auth_email_otp_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  email_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ineligible', 'delivery_failed', 'consumed', 'locked')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consume_nonce TEXT,
  provider_message_id TEXT,
  request_id TEXT,
  redirect_path TEXT NOT NULL DEFAULT '/home',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_email_otp_email_created ON auth_email_otp_challenges(email_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_email_otp_ip_created ON auth_email_otp_challenges(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_email_otp_expires ON auth_email_otp_challenges(expires_at, status);

UPDATE auth_users
SET name = 'AI Adoption Platform',
    email = 'ai-adoption@example.invalid',
    status = CASE WHEN status = 'invited' THEN 'active' ELSE status END,
    department_id = 'dept-ai-adoption-zwlqiw',
    department_name = 'Workspace Wealth / AI Adoption',
    department_path_json = '["dept-workspace-wealth-1iwh8yl","dept-ai-adoption-zwlqiw"]',
    provider = 'microsoft_entra_id',
    provider_subject = '3634bd9b-137f-41f8-9a3c-20e8914c0c84',
    source = 'platform_ops',
    updated_at = CURRENT_TIMESTAMP
WHERE lower(email) = lower('ai-adoption@example.invalid');

INSERT INTO auth_users (
  id,
  email,
  job_title,
  name,
  role,
  status,
  department_id,
  department_name,
  department_path_json,
  team_id,
  team_name,
  team_path_json,
  provider,
  provider_subject,
  source,
  first_seen_at,
  last_seen_at,
  updated_at
)
SELECT
  '3634bd9b-137f-41f8-9a3c-20e8914c0c84',
  'ai-adoption@example.invalid',
  '',
  'AI Adoption Platform',
  'member',
  'active',
  'dept-ai-adoption-zwlqiw',
  'Workspace Wealth / AI Adoption',
  '["dept-workspace-wealth-1iwh8yl","dept-ai-adoption-zwlqiw"]',
  NULL,
  '',
  '[]',
  'microsoft_entra_id',
  '3634bd9b-137f-41f8-9a3c-20e8914c0c84',
  'platform_ops',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1
  FROM auth_users
  WHERE lower(email) = lower('ai-adoption@example.invalid')
);

INSERT INTO auth_user_memberships (
  user_id,
  target_type,
  target_id,
  target_name,
  target_path_json,
  status,
  source,
  created_at,
  updated_at
)
VALUES (
  (SELECT id FROM auth_users WHERE lower(email) = lower('ai-adoption@example.invalid') LIMIT 1),
  'department',
  'dept-ai-adoption-zwlqiw',
  'Workspace Wealth / AI Adoption',
  '["dept-workspace-wealth-1iwh8yl","dept-ai-adoption-zwlqiw"]',
  'active',
  'platform_ops',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT(user_id, target_type, target_id) DO UPDATE SET
  target_name = excluded.target_name,
  target_path_json = excluded.target_path_json,
  status = 'active',
  source = excluded.source,
  updated_at = CURRENT_TIMESTAMP;
