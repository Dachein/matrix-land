ALTER TABLE publication_listings
ADD COLUMN desired_status TEXT NOT NULL DEFAULT 'pending_review'
CHECK (desired_status IN ('pending_review', 'listed', 'delisted', 'deleted'));

ALTER TABLE publication_listings
ADD COLUMN effective_status TEXT NOT NULL DEFAULT 'pending_review'
CHECK (effective_status IN ('pending_review', 'listed', 'delisted', 'deleted'));

ALTER TABLE publication_listings
ADD COLUMN publication_status TEXT NOT NULL DEFAULT 'synced'
CHECK (publication_status IN ('synced', 'pending', 'failed', 'not_required'));

ALTER TABLE publication_listings
ADD COLUMN publication_error_code TEXT NOT NULL DEFAULT '';

ALTER TABLE publication_listings
ADD COLUMN publication_updated_at TEXT;

UPDATE publication_listings
SET desired_status = status,
    effective_status = status,
    publication_status = 'synced',
    publication_error_code = '',
    publication_updated_at = CURRENT_TIMESTAMP;

CREATE TABLE publication_publication_outbox (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES publication_listings(id) ON DELETE RESTRICT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('app', 'resource', 'none')),
  target_id TEXT NOT NULL,
  desired_status TEXT NOT NULL CHECK (desired_status IN ('pending_review', 'listed', 'delisted', 'deleted')),
  endpoint_path TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'completed', 'failed', 'superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_http_status INTEGER,
  last_request_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE(listing_id, desired_status, payload_hash)
);

CREATE INDEX idx_publication_publication_outbox_ready
ON publication_publication_outbox(state, next_attempt_at, created_at);

CREATE INDEX idx_publication_publication_outbox_listing
ON publication_publication_outbox(listing_id, created_at DESC);

CREATE INDEX idx_publication_listings_effective_status
ON publication_listings(listing_type, effective_status, updated_at);
