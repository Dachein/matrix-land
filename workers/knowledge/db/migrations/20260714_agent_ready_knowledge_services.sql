-- Knowledge Service is an Agent-ready folder, not an installable Skill.
-- Folder permissions are the only authorization source. Legacy visibility and
-- access_targets_json columns remain temporarily so this migration is additive.

ALTER TABLE knowledge_services ADD COLUMN agent_enabled INTEGER NOT NULL DEFAULT 0 CHECK (agent_enabled IN (0, 1));
ALTER TABLE knowledge_services ADD COLUMN index_status TEXT NOT NULL DEFAULT 'disabled' CHECK (index_status IN ('disabled', 'queued', 'indexing', 'ready', 'stale', 'error'));
ALTER TABLE knowledge_services ADD COLUMN index_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_services ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_services ADD COLUMN indexed_at TEXT;
ALTER TABLE knowledge_services ADD COLUMN last_error TEXT NOT NULL DEFAULT '';

-- Only legacy services whose service ACL was already private/empty can be
-- enabled without broadening access. Services with an independent visibility
-- or target list remain disabled until the Owner confirms folder ACL settings.
-- Legacy fields are intentionally retained for that audit.
UPDATE knowledge_services
SET agent_enabled = CASE
      WHEN status = 'active'
        AND visibility = 'private'
        AND trim(IFNULL(access_targets_json, '[]')) IN ('', '[]')
      THEN 1 ELSE 0 END,
    index_status = CASE
      WHEN status = 'active'
        AND visibility = 'private'
        AND trim(IFNULL(access_targets_json, '[]')) IN ('', '[]')
      THEN 'stale' ELSE 'disabled' END,
    update_mode = 'auto',
    updated_at = CURRENT_TIMESTAMP;

-- Rename only the file already referenced as a service handbook and only when
-- handbook.md does not already exist. The object id and all versions stay stable.
UPDATE knowledge_objects
SET file_name = 'handbook.md',
    path = CASE WHEN parent_path = '' THEN 'handbook.md' ELSE parent_path || '/handbook.md' END,
    title = CASE WHEN title = '' OR lower(title) = 'skill.md' THEN 'handbook.md' ELSE title END,
    updated_at = CURRENT_TIMESTAMP
WHERE lower(file_name) = 'skill.md'
  AND id IN (SELECT handbook_object_id FROM knowledge_services)
  AND NOT EXISTS (
    SELECT 1 FROM knowledge_objects AS handbook
    WHERE handbook.namespace_id = knowledge_objects.namespace_id
      AND handbook.parent_path = knowledge_objects.parent_path
      AND lower(handbook.file_name) = 'handbook.md'
  );

-- A name conflict can prevent the in-place rename above. Never leave such a
-- service Agent-enabled with a non-canonical handbook pointer; the Owner can
-- review the two files and re-enable it through the control plane.
UPDATE knowledge_services
SET agent_enabled = 0,
    index_status = 'disabled',
    updated_at = CURRENT_TIMESTAMP
WHERE agent_enabled = 1
  AND handbook_object_id IN (
    SELECT id FROM knowledge_objects WHERE lower(file_name) != 'handbook.md'
  );

-- A subject has exactly one active role per target. Prefer the most recently
-- updated row before replacing the legacy role-sensitive unique index.
UPDATE knowledge_permissions AS permission
SET revoked_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE permission.revoked_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM knowledge_permissions AS newer
    WHERE newer.namespace_id = permission.namespace_id
      AND IFNULL(newer.object_id, '') = IFNULL(permission.object_id, '')
      AND newer.subject_type = permission.subject_type
      AND newer.subject_id = permission.subject_id
      AND newer.revoked_at IS NULL
      AND newer.id != permission.id
      AND (newer.updated_at > permission.updated_at OR (newer.updated_at = permission.updated_at AND newer.id > permission.id))
  );

DROP INDEX IF EXISTS idx_knowledge_permissions_unique_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_permissions_unique_active
  ON knowledge_permissions(namespace_id, IFNULL(object_id, ''), subject_type, subject_id)
  WHERE revoked_at IS NULL;

-- Ownership is derived from namespace ownership (or an in-org admin), never
-- from a grant. Demote any legacy explicit owner grant to collaborator storage.
UPDATE knowledge_permissions
SET role = 'editor', updated_at = CURRENT_TIMESTAMP
WHERE role = 'owner';

CREATE INDEX IF NOT EXISTS idx_knowledge_services_agent_access
  ON knowledge_services(namespace_id, agent_enabled, status, index_status);

-- Retain only the newest non-revoked public link per file before enforcing the
-- invariant at the database layer. POST rotates this row; GET never creates.
UPDATE knowledge_shares AS share
SET revoked_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE share.visibility = 'public'
  AND share.revoked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM knowledge_shares AS newer
    WHERE newer.object_id = share.object_id
      AND newer.visibility = 'public'
      AND newer.revoked_at IS NULL
      AND newer.id != share.id
      AND (newer.created_at > share.created_at OR (newer.created_at = share.created_at AND newer.id > share.id))
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_shares_one_active_public
  ON knowledge_shares(object_id)
  WHERE visibility = 'public' AND revoked_at IS NULL;
