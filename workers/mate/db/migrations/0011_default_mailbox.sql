-- Canonical incoming mail belongs to an organization/user, not to the sender
-- or a task. Old task-email metadata is intentionally not backfilled as mail.
CREATE TABLE mate_mail_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  mate_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  subject TEXT NOT NULL,
  received_at TEXT NOT NULL,
  object_key TEXT NOT NULL,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  labels_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, user_id, digest)
);
CREATE INDEX mate_mail_owner_page ON mate_mail_messages(org_id, user_id, received_at DESC, id DESC);
