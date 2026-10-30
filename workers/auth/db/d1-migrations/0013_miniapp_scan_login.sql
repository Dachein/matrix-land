CREATE TABLE IF NOT EXISTS auth_miniapp_login_tickets (
  ticket_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired')),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_miniapp_login_user
  ON auth_miniapp_login_tickets(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_miniapp_login_expiry
  ON auth_miniapp_login_tickets(expires_at, status);
