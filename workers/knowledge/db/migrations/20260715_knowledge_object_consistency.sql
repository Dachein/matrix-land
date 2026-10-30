-- Fresh databases use a partial unique index for active object paths. Existing
-- D1 databases still have the legacy table-level UNIQUE(namespace_id, path).
-- Rebuilding knowledge_objects alone is unsafe: D1 keeps ON DELETE CASCADE
-- actions active even with defer_foreign_keys enabled, and this table is the
-- parent of versions, permissions, shares, tokens, and services. Move historical
-- tombstones outside the user-valid path domain instead of dropping that table.

-- A deleted object must not retain an active grant, public link, or open token.
UPDATE knowledge_permissions
SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
    updated_at = CURRENT_TIMESTAMP
WHERE revoked_at IS NULL
  AND object_id IN (SELECT id FROM knowledge_objects WHERE deleted_at IS NOT NULL);

UPDATE knowledge_shares
SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
    updated_at = CURRENT_TIMESTAMP
WHERE revoked_at IS NULL
  AND object_id IN (SELECT id FROM knowledge_objects WHERE deleted_at IS NOT NULL);

UPDATE knowledge_open_tokens
SET consumed_at = COALESCE(consumed_at, CURRENT_TIMESTAMP)
WHERE consumed_at IS NULL
  AND object_id IN (SELECT id FROM knowledge_objects WHERE deleted_at IS NOT NULL);

UPDATE knowledge_services
SET status = 'archived',
    updated_at = CURRENT_TIMESTAMP
WHERE status != 'archived'
  AND (
    folder_object_id IN (SELECT id FROM knowledge_objects WHERE deleted_at IS NOT NULL)
    OR handbook_object_id IN (SELECT id FROM knowledge_objects WHERE deleted_at IS NOT NULL)
  );

-- normalizePath() always removes leading slashes, so this namespace is
-- unreachable through user input. The object id makes each tombstone unique.
-- Preserve the original location in metadata for audit and future restore work.
UPDATE knowledge_objects
SET metadata_json = json_set(
      CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
      '$.deletedOriginalPath', path,
      '$.deletedOriginalParentPath', parent_path
    ),
    parent_path = '/.workspace-deleted',
    path = '/.workspace-deleted/' || id,
    updated_at = CURRENT_TIMESTAMP
WHERE deleted_at IS NOT NULL
  AND substr(path, 1, length('/.workspace-deleted/')) != '/.workspace-deleted/';

-- used_bytes is logical current content, not the sum of retained versions.
UPDATE knowledge_namespaces
SET used_bytes = COALESCE((
      SELECT SUM(size_bytes)
      FROM knowledge_objects
      WHERE knowledge_objects.namespace_id = knowledge_namespaces.id
        AND knowledge_objects.deleted_at IS NULL
        AND knowledge_objects.object_kind = 'file'
    ), 0),
    updated_at = CURRENT_TIMESTAMP;

-- On legacy tables this coexists with the old auto-index; tombstone relocation
-- makes that stricter constraint harmless. Fresh schema installations have only
-- this active-row invariant and do not need a risky parent-table rebuild.
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_objects_unique_active_path
  ON knowledge_objects(namespace_id, path)
  WHERE deleted_at IS NULL;
