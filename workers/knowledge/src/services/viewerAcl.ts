import { permissionRowsForObject } from "../access/authorization.ts";
import { permissionRoleForRow, validateSubjectId } from "../access/policy.ts";
import { HttpError } from "../http.ts";
import type { Env, KnowledgeServiceAccessSettings, NamespaceRow, ObjectRow, PermissionRow, Principal } from "../types.ts";
import { isRecord } from "../values.ts";

export function parseKnowledgeServiceAccessSettings(value: unknown, orgId: string): KnowledgeServiceAccessSettings | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new HttpError(400, "invalid_knowledge_service_access");
  }
  if (value.company !== undefined && typeof value.company !== "boolean") {
    throw new HttpError(400, "invalid_knowledge_service_company_access");
  }
  const users = parseKnowledgeServiceAccessSubjectIds(value.users, "user", orgId);
  const departments = parseKnowledgeServiceAccessSubjectIds(value.departments, "department", orgId);
  const company = value.company === true;
  if (company && (users.length > 0 || departments.length > 0)) {
    throw new HttpError(400, "knowledge_service_access_mode_conflict");
  }
  if (users.length + departments.length > 500) {
    throw new HttpError(400, "knowledge_service_access_too_many_subjects");
  }
  return { company, users, departments };
}

function parseKnowledgeServiceAccessSubjectIds(
  value: unknown,
  subjectType: "user" | "department",
  orgId: string
) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, `invalid_knowledge_service_${subjectType}_access`);
  }
  const ids = value.map((item) => {
    if (typeof item !== "string") {
      throw new HttpError(400, `invalid_knowledge_service_${subjectType}_access`);
    }
    return validateSubjectId(item, subjectType, orgId);
  });
  return [...new Set(ids)].sort();
}

export async function assertKnowledgeServiceViewerPolicyCanBeRepresented(
  env: Env,
  namespace: NamespaceRow,
  folder: ObjectRow,
  access: KnowledgeServiceAccessSettings
) {
  if (access.company) {
    return;
  }
  const allowedUsers = new Set(access.users);
  const allowedDepartments = new Set(access.departments);
  const inheritedViewerGrants = (await permissionRowsForObject(env, namespace.id, folder)).filter((row) => (
    row.object_id !== folder.id
    && permissionRoleForRow(row) === "viewer"
  ));
  const unrepresented = inheritedViewerGrants.filter((row) => {
    if (row.subject_type === "user") {
      return !allowedUsers.has(row.subject_id);
    }
    if (row.subject_type === "department") {
      return !allowedDepartments.has(row.subject_id);
    }
    // A company, team, or MCP-client grant cannot be expressed by the
    // targeted user/department control, so claiming "only selected" would be
    // misleading. The owner may use company access or narrow the ancestor ACL.
    return true;
  });
  if (unrepresented.length > 0) {
    throw new HttpError(409, "knowledge_service_inherited_viewer_conflict");
  }
}

export function knowledgeServiceAccessMutationStatements(
  env: Env,
  namespace: NamespaceRow,
  folder: ObjectRow,
  principal: Principal,
  access: KnowledgeServiceAccessSettings,
  serviceId: string
) {
  const statements: D1PreparedStatement[] = [
    ...serviceViewerGrantRevokeStatements(env, serviceId)
  ];
  const subjects: Array<{ type: "company" | "user" | "department"; id: string }> = access.company
    ? [{ type: "company", id: namespace.org_id }]
    : [
      ...access.users.map((id) => ({ type: "user" as const, id })),
      ...access.departments.map((id) => ({ type: "department" as const, id }))
    ];
  for (const subject of subjects) {
    const permissionId = `kperm_${crypto.randomUUID()}`;
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_permissions (
             id, namespace_id, object_id, subject_type, subject_id, role,
             can_share, can_publish_skill, granted_by_user_id, expires_at
           )
           SELECT ?, ?, ?, ?, ?, 'viewer', 0, 0, ?, NULL
           WHERE NOT EXISTS (
             SELECT 1 FROM knowledge_permissions
             WHERE namespace_id = ? AND object_id = ? AND subject_type = ? AND subject_id = ? AND revoked_at IS NULL
           )`
        )
        .bind(
          permissionId,
          namespace.id,
          folder.id,
          subject.type,
          subject.id,
          principal.sub,
          namespace.id,
          folder.id,
          subject.type,
          subject.id
        ),
      env.KNOWLEDGE_DB
        .prepare(
          `INSERT INTO knowledge_permission_provenance (
             permission_id, grant_source, source_id
           )
           SELECT id, 'knowledge_service', ?
           FROM knowledge_permissions
           WHERE namespace_id = ? AND object_id = ?
             AND subject_type = ? AND subject_id = ? AND revoked_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM knowledge_permission_provenance AS existing_provenance
               WHERE existing_provenance.permission_id = knowledge_permissions.id
                 AND existing_provenance.grant_source = 'direct'
             )
           ON CONFLICT(permission_id) DO UPDATE SET
             grant_source = 'knowledge_service',
             source_id = excluded.source_id,
             updated_at = CURRENT_TIMESTAMP`
        )
        .bind(serviceId, namespace.id, folder.id, subject.type, subject.id)
    );
  }
  return statements;
}

export function serviceViewerGrantRevokeStatements(env: Env, serviceId: string) {
  return [
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_permission_provenance
         SET grant_source = 'direct',
             source_id = (
               SELECT object_id FROM knowledge_permissions
               WHERE knowledge_permissions.id = knowledge_permission_provenance.permission_id
             ),
             updated_at = CURRENT_TIMESTAMP
         WHERE grant_source = 'knowledge_service' AND source_id = ?
           AND permission_id IN (
             SELECT id FROM knowledge_permissions
             WHERE revoked_at IS NULL AND role IN ('owner', 'editor', 'collaborator')
           )`
      )
      .bind(serviceId),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_permissions
         SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE revoked_at IS NULL
           AND role = 'viewer'
           AND id IN (
             SELECT permission_id
             FROM knowledge_permission_provenance
             WHERE grant_source = 'knowledge_service' AND source_id = ?
           )`
      )
      .bind(serviceId)
  ];
}

export async function readKnowledgeServiceAccessSettings(
  env: Env,
  namespace: NamespaceRow,
  folder: ObjectRow,
  serviceId: string
): Promise<KnowledgeServiceAccessSettings> {
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT permission.subject_type, permission.subject_id
       FROM knowledge_permissions AS permission
       JOIN knowledge_permission_provenance AS provenance
         ON provenance.permission_id = permission.id
       WHERE permission.namespace_id = ?
         AND permission.object_id = ?
         AND permission.subject_type IN ('company', 'user', 'department')
         AND permission.role = 'viewer'
         AND permission.revoked_at IS NULL
         AND (permission.expires_at IS NULL OR datetime(permission.expires_at) > CURRENT_TIMESTAMP)
         AND provenance.grant_source = 'knowledge_service'
         AND provenance.source_id = ?
       ORDER BY permission.subject_type, permission.subject_id`
    )
    .bind(namespace.id, folder.id, serviceId)
    .all<Pick<PermissionRow, "subject_type" | "subject_id">>();
  const users: string[] = [];
  const departments: string[] = [];
  let company = false;
  for (const row of rows.results ?? []) {
    if (row.subject_type === "company" && row.subject_id === namespace.org_id) company = true;
    if (row.subject_type === "user") users.push(row.subject_id);
    if (row.subject_type === "department") departments.push(row.subject_id);
  }
  return { company, users, departments };
}
