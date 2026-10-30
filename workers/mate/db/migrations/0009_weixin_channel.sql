-- Mate 3.0-owned Weixin private-channel state. Message bodies remain in
-- the per-user Agent DO; D1 stores only bindings, encrypted credentials and
-- idempotency receipts.

CREATE TABLE IF NOT EXISTS mate_weixin_qr_sessions (
  id TEXT PRIMARY KEY,
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'scanned', 'need_verify_code', 'confirmed', 'expired', 'failed'
  )),
  qr_url TEXT NOT NULL,
  qr_ciphertext TEXT NOT NULL,
  qr_iv TEXT NOT NULL,
  verify_code_ciphertext TEXT,
  verify_code_iv TEXT,
  polling_base_url TEXT NOT NULL,
  error_code TEXT,
  binding_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mate_weixin_qr_user
  ON mate_weixin_qr_sessions(mate_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mate_weixin_qr_expiry
  ON mate_weixin_qr_sessions(expires_at);

CREATE TABLE IF NOT EXISTS mate_weixin_bindings (
  id TEXT PRIMARY KEY,
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  channel_account_hash TEXT NOT NULL,
  external_subject_hash TEXT NOT NULL,
  credentials_ciphertext TEXT NOT NULL,
  credentials_iv TEXT NOT NULL,
  active_conversation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  bound_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mate_weixin_active_user
  ON mate_weixin_bindings(mate_id, user_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_mate_weixin_active_subject
  ON mate_weixin_bindings(external_subject_hash) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_mate_weixin_status
  ON mate_weixin_bindings(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS mate_weixin_message_receipts (
  binding_id TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed', 'ignored')),
  request_id TEXT NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (binding_id, external_message_id),
  FOREIGN KEY (binding_id) REFERENCES mate_weixin_bindings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mate_weixin_receipts_created
  ON mate_weixin_message_receipts(created_at);
