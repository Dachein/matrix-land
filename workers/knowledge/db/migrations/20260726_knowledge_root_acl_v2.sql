-- Knowledge Service V2 Root ACL and Service Viewer provenance.
--
-- Production inventory must be reviewed before this migration is applied.
-- The migration is idempotent for the currently supported rollout state:
-- no duplicate active Root Owners and no nested active Services.

PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO knowledge_permission_provenance (
  permission_id, grant_source, source_id
)
SELECT
  permission.id,
  'knowledge_service',
  service.id
FROM knowledge_permissions AS permission
JOIN knowledge_services AS service
  ON service.namespace_id = permission.namespace_id
 AND service.folder_object_id = permission.object_id
WHERE permission.revoked_at IS NULL
  AND permission.role = 'viewer'
  AND service.status = 'active'
  AND service.agent_enabled = 1;

INSERT OR IGNORE INTO knowledge_permission_provenance (
  permission_id, grant_source, source_id
)
SELECT
  permission.id,
  'direct',
  permission.object_id
FROM knowledge_permissions AS permission
WHERE permission.revoked_at IS NULL
  AND permission.object_id IS NOT NULL
  AND permission.role IN ('editor', 'collaborator', 'owner');

UPDATE knowledge_permissions
SET role = 'owner',
    can_share = 1,
    can_publish_skill = 0,
    expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  SELECT permission.id
  FROM knowledge_permissions AS permission
  JOIN knowledge_objects AS root ON root.id = permission.object_id
  JOIN knowledge_namespaces AS namespace ON namespace.id = root.namespace_id
  WHERE root.object_kind = 'folder'
    AND root.parent_path = ''
    AND root.deleted_at IS NULL
    AND permission.subject_type = 'user'
    AND permission.subject_id = namespace.owner_user_id
    AND permission.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM knowledge_permissions AS existing_owner
      WHERE existing_owner.object_id = root.id
        AND existing_owner.subject_type = 'user'
        AND existing_owner.role = 'owner'
        AND existing_owner.revoked_at IS NULL
    )
);

INSERT OR IGNORE INTO knowledge_permissions (
  id,
  namespace_id,
  object_id,
  subject_type,
  subject_id,
  role,
  can_share,
  can_publish_skill,
  granted_by_user_id,
  expires_at
)
SELECT
  'kperm_root_' || lower(hex(randomblob(16))),
  root.namespace_id,
  root.id,
  'user',
  namespace.owner_user_id,
  'owner',
  1,
  0,
  namespace.owner_user_id,
  NULL
FROM knowledge_objects AS root
JOIN knowledge_namespaces AS namespace ON namespace.id = root.namespace_id
WHERE root.object_kind = 'folder'
  AND root.parent_path = ''
  AND root.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM knowledge_permissions AS permission
    WHERE permission.object_id = root.id
      AND permission.subject_type = 'user'
      AND permission.role = 'owner'
      AND permission.revoked_at IS NULL
  );

INSERT INTO knowledge_permission_provenance (
  permission_id, grant_source, source_id
)
SELECT
  permission.id,
  'direct',
  permission.object_id
FROM knowledge_permissions AS permission
JOIN knowledge_objects AS root ON root.id = permission.object_id
WHERE permission.revoked_at IS NULL
  AND permission.subject_type = 'user'
  AND permission.role = 'owner'
  AND root.object_kind = 'folder'
  AND root.parent_path = ''
  AND root.deleted_at IS NULL
ON CONFLICT(permission_id) DO UPDATE SET
  grant_source = 'direct',
  source_id = excluded.source_id,
  updated_at = CURRENT_TIMESTAMP;

-- Viewer is a Service lifecycle role, never a standalone collaboration grant.
-- Preserve only Viewer rows that were tied to an enabled Service above. A
-- Namespace custodian that previously held Viewer has already been promoted
-- to the unique Root Owner by this point.
UPDATE knowledge_permissions
SET revoked_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE revoked_at IS NULL
  AND role = 'viewer'
  AND NOT EXISTS (
    SELECT 1
    FROM knowledge_permission_provenance AS provenance
    WHERE provenance.permission_id = knowledge_permissions.id
      AND provenance.grant_source = 'knowledge_service'
      AND provenance.source_id != ''
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_permissions_one_active_root_owner
  ON knowledge_permissions(object_id)
  WHERE subject_type = 'user'
    AND role = 'owner'
    AND revoked_at IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_permissions_root_insert
BEFORE INSERT ON knowledge_permissions
WHEN NEW.object_id IS NOT NULL
  AND NEW.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM knowledge_objects AS root
    WHERE root.id = NEW.object_id
      AND root.namespace_id = NEW.namespace_id
      AND root.object_kind = 'folder'
      AND root.parent_path = ''
      AND root.deleted_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'knowledge_acl_root_required');
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_permissions_root_update
BEFORE UPDATE OF namespace_id, object_id, revoked_at ON knowledge_permissions
WHEN NEW.object_id IS NOT NULL
  AND NEW.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM knowledge_objects AS root
    WHERE root.id = NEW.object_id
      AND root.namespace_id = NEW.namespace_id
      AND root.object_kind = 'folder'
      AND root.parent_path = ''
      AND root.deleted_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'knowledge_acl_root_required');
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_permissions_owner_user_insert
BEFORE INSERT ON knowledge_permissions
WHEN NEW.revoked_at IS NULL
  AND NEW.role = 'owner'
  AND NEW.subject_type != 'user'
BEGIN
  SELECT RAISE(ABORT, 'knowledge_owner_subject_must_be_user');
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_permissions_owner_user_update
BEFORE UPDATE OF role, subject_type, revoked_at ON knowledge_permissions
WHEN NEW.revoked_at IS NULL
  AND NEW.role = 'owner'
  AND NEW.subject_type != 'user'
BEGIN
  SELECT RAISE(ABORT, 'knowledge_owner_subject_must_be_user');
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_services_root_insert
BEFORE INSERT ON knowledge_services
WHEN NOT EXISTS (
  SELECT 1
  FROM knowledge_objects AS root
  WHERE root.id = NEW.folder_object_id
    AND root.namespace_id = NEW.namespace_id
    AND root.object_kind = 'folder'
    AND root.parent_path = ''
    AND root.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'knowledge_service_root_required');
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_services_root_update
BEFORE UPDATE OF namespace_id, folder_object_id ON knowledge_services
WHEN NOT EXISTS (
  SELECT 1
  FROM knowledge_objects AS root
  WHERE root.id = NEW.folder_object_id
    AND root.namespace_id = NEW.namespace_id
    AND root.object_kind = 'folder'
    AND root.parent_path = ''
    AND root.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'knowledge_service_root_required');
END;
