PRAGMA foreign_keys = ON;

-- Existing first-party text versions are trusted only as a migration baseline.
-- New writes are classified by builtin-policy-v1 in the Worker. Complex binary
-- files remain pending until an external scanner marks the exact version clean.
INSERT INTO knowledge_ingestion_states (
  object_id,
  version_id,
  scan_status,
  scanner_version,
  reason_code,
  scanned_at
)
SELECT
  object.id,
  version.id,
  CASE
    WHEN object.content_kind IN ('text', 'markdown', 'html') THEN 'clean'
    ELSE 'pending'
  END,
  'migration-trust-v1',
  CASE
    WHEN object.content_kind IN ('text', 'markdown', 'html') THEN 'trusted_existing_text'
    ELSE 'external_scanner_required'
  END,
  CASE
    WHEN object.content_kind IN ('text', 'markdown', 'html') THEN CURRENT_TIMESTAMP
    ELSE NULL
  END
FROM knowledge_objects AS object
JOIN knowledge_object_versions AS version ON version.object_id = object.id
WHERE NOT EXISTS (
  SELECT 1
  FROM knowledge_ingestion_states AS state
  WHERE state.object_id = object.id
    AND state.version_id = version.id
);
