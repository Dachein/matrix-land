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
