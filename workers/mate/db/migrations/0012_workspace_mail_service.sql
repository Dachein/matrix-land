CREATE TABLE workspace_mail_mailboxes (
  mate_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
  owner_kind TEXT NOT NULL DEFAULT 'mate',owner_id TEXT,receive_enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'provisioning', routing_rule_id TEXT, last_error TEXT, checked_at TEXT
);
CREATE INDEX workspace_mail_owner ON workspace_mail_mailboxes(org_id,user_id,is_default);
CREATE TABLE workspace_mail_events (
  message_id TEXT PRIMARY KEY REFERENCES mate_mail_messages(id), org_id TEXT NOT NULL,
  user_id TEXT NOT NULL, mate_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, delivered_at TEXT, last_error TEXT
);
CREATE TABLE workspace_mail_outbound (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, mate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, recipient TEXT NOT NULL,
  subject TEXT NOT NULL, message_id TEXT NOT NULL, provider_id TEXT, status TEXT NOT NULL,
  error TEXT, object_key TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,user_id,mate_id,idempotency_key)
);
CREATE TABLE workspace_mail_inbox_runs (
  message_id TEXT PRIMARY KEY, mate_id TEXT NOT NULL, user_id TEXT NOT NULL, org_id TEXT NOT NULL,
  release_id TEXT, manifest_sha256 TEXT, decision_json TEXT,
  task_id TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TEXT, next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workspace_mail_app_grants (
  app_id TEXT PRIMARY KEY,org_id TEXT NOT NULL,user_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,
  inbox_id TEXT,sender_id TEXT,receive_enabled INTEGER NOT NULL,send_enabled INTEGER NOT NULL,enabled INTEGER NOT NULL
);

CREATE UNIQUE INDEX workspace_mail_default_owner ON workspace_mail_mailboxes(org_id,user_id) WHERE is_default=1 AND owner_kind='mate';
CREATE INDEX workspace_mail_events_due ON workspace_mail_events(next_attempt_at) WHERE delivered_at IS NULL;
CREATE INDEX workspace_mail_inbox_due ON workspace_mail_inbox_runs(next_attempt_at,updated_at) WHERE status IN ('pending','processing','task');
CREATE INDEX workspace_mail_sent_page ON workspace_mail_outbound(org_id,user_id,mate_id,created_at DESC,id DESC);

CREATE TABLE workspace_mail_legacy_cleanup(object_key TEXT PRIMARY KEY,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
