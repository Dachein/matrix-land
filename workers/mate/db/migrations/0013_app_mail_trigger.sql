ALTER TABLE workspace_mail_app_grants ADD COLUMN trigger_enabled INTEGER NOT NULL DEFAULT 0 CHECK (trigger_enabled IN (0,1));
ALTER TABLE workspace_mail_app_grants ADD COLUMN trigger_enabled_at TEXT;
CREATE INDEX IF NOT EXISTS workspace_mail_events_mailbox_time ON workspace_mail_events(mate_id,next_attempt_at);
ALTER TABLE workspace_mail_events ADD COLUMN app_lease_token TEXT;
ALTER TABLE workspace_mail_events ADD COLUMN app_lease_until TEXT;
