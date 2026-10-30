-- Collaborator is a personal role. Historical elevated grants for a company,
-- department, team, or MCP client must remain readable but may not edit or
-- create public links. This is a data-only, idempotent hardening migration.
UPDATE knowledge_permissions
SET role = 'viewer',
    can_share = 0,
    can_publish_skill = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE subject_type != 'user'
  AND role IN ('editor', 'collaborator', 'owner');

-- Ownership comes only from namespace ownership or an in-organization admin.
-- Preserve legacy personal owner grants as Collaborator for compatibility.
UPDATE knowledge_permissions
SET role = 'editor',
    can_share = 1,
    can_publish_skill = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE subject_type = 'user'
  AND role = 'owner';
