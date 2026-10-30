-- Microsoft authorization remains owned by Auth, keyed by the canonical user ID.
CREATE TABLE auth_microsoft365_connections (
  user_id TEXT PRIMARY KEY REFERENCES auth_users(id),
  generation TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  credential_ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reauthorize')),
  refresh_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX auth_microsoft365_identity ON auth_microsoft365_connections(tenant_id, object_id);
CREATE TABLE auth_microsoft365_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id),
  claimed INTEGER NOT NULL DEFAULT 0,
  credential_ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_microsoft365_states_expiry ON auth_microsoft365_states(expires_at);
