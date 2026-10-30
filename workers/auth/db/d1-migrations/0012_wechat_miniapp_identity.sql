CREATE TABLE IF NOT EXISTS auth_miniapp_bind_tickets (
  scene_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired')),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_miniapp_identities (
  app_id TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  bound_at INTEGER NOT NULL,
  last_login_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, subject_hash)
);

CREATE INDEX IF NOT EXISTS idx_auth_miniapp_bind_user ON auth_miniapp_bind_tickets(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_miniapp_bind_expiry ON auth_miniapp_bind_tickets(expires_at, status);
CREATE INDEX IF NOT EXISTS idx_auth_miniapp_identity_user ON auth_miniapp_identities(user_id, status);
