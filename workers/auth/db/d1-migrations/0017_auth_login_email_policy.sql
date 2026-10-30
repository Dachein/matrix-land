CREATE TABLE IF NOT EXISTS auth_login_email_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('open', 'company_email_only')),
  allowed_domains_json TEXT NOT NULL DEFAULT '[]',
  updated_by_user_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO auth_login_email_policy (id, mode, allowed_domains_json)
VALUES (
  1,
  'company_email_only',
  '[]'
);
