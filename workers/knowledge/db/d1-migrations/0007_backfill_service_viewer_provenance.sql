-- Reconcile active Service Viewer grants created without their provenance row.
-- Only a unique active, Agent-enabled Service on the same folder is safe to infer.
INSERT OR IGNORE INTO knowledge_permission_provenance (
  permission_id, grant_source, source_id
)
SELECT permission.id, 'knowledge_service', MIN(service.id)
FROM knowledge_permissions AS permission
JOIN knowledge_services AS service
  ON service.namespace_id = permission.namespace_id
 AND service.folder_object_id = permission.object_id
LEFT JOIN knowledge_permission_provenance AS provenance
  ON provenance.permission_id = permission.id
WHERE permission.revoked_at IS NULL
  AND permission.role = 'viewer'
  AND permission.subject_type IN ('company', 'user', 'department')
  AND provenance.permission_id IS NULL
  AND service.status = 'active'
  AND service.agent_enabled = 1
GROUP BY permission.id
HAVING COUNT(DISTINCT service.id) = 1;
