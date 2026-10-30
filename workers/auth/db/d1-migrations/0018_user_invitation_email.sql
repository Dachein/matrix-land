CREATE TABLE IF NOT EXISTS auth_user_invitation_emails (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','uncertain','cancelled')),
  recipient TEXT,
  message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_user_invitation_pending ON auth_user_invitation_emails(status,created_at);
CREATE TRIGGER IF NOT EXISTS auth_user_invitation_insert
AFTER INSERT ON auth_users
WHEN NEW.status='invited' AND trim(NEW.email)<>''
BEGIN
  INSERT OR IGNORE INTO auth_user_invitation_emails(user_id) VALUES(NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS auth_user_invitation_transition
AFTER UPDATE OF status,email ON auth_users
WHEN NEW.status='invited' AND trim(NEW.email)<>'' AND (OLD.status<>'invited' OR trim(OLD.email)='')
BEGIN
  INSERT OR IGNORE INTO auth_user_invitation_emails(user_id) VALUES(NEW.id);
END;
