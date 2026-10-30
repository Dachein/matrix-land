CREATE TABLE workspace_bootstrap_claim (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 token_hash TEXT NOT NULL UNIQUE,
 email TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 consumed_at INTEGER,
 created_at INTEGER NOT NULL
);
CREATE TABLE workspace_ownership (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 user_id TEXT NOT NULL REFERENCES auth_users(id),
 claimed_at INTEGER NOT NULL
);
CREATE TABLE workspace_ownership_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 previous_user_id TEXT,
 user_id TEXT NOT NULL,
 changed_at INTEGER NOT NULL
);
CREATE TRIGGER workspace_owner_claimed AFTER INSERT ON workspace_ownership
BEGIN
 UPDATE auth_users SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE id = NEW.user_id;
 UPDATE workspace_bootstrap_claim SET consumed_at = NEW.claimed_at WHERE id = 1;
 INSERT INTO workspace_ownership_audit(previous_user_id,user_id,changed_at) VALUES(NULL,NEW.user_id,NEW.claimed_at);
END;
CREATE TRIGGER workspace_owner_transferred AFTER UPDATE OF user_id ON workspace_ownership
BEGIN
 UPDATE auth_users SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE id = NEW.user_id;
 INSERT INTO workspace_ownership_audit(previous_user_id,user_id,changed_at) VALUES(OLD.user_id,NEW.user_id,unixepoch());
END;
CREATE TRIGGER workspace_owner_preserve_access BEFORE UPDATE OF role,status ON auth_users
WHEN EXISTS(SELECT 1 FROM workspace_ownership WHERE user_id = OLD.id) AND (NEW.role != 'admin' OR NEW.status != 'active')
BEGIN SELECT RAISE(ABORT, 'transfer_workspace_ownership_first'); END;
CREATE TRIGGER workspace_owner_preserve_user BEFORE DELETE ON auth_users
WHEN EXISTS(SELECT 1 FROM workspace_ownership WHERE user_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'transfer_workspace_ownership_first'); END;
CREATE TRIGGER workspace_owner_preserve_record BEFORE DELETE ON workspace_ownership
BEGIN SELECT RAISE(ABORT, 'workspace_requires_owner'); END;
