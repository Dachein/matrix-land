import type { Env, Principal, KnowledgeServiceRow, PermissionRow } from "../types.ts";
import { HttpError } from "../http.ts";
import { isRecord, readString } from "../values.ts";
import { canonicalPermissionRole } from "../access/policy.ts";
import { knowledgeServiceJson } from "./representation.ts";

export async function assertKnowledgeAdminReadPrincipal(
  request: Request,
  env: Env,
  principal: Principal,
  fetchImpl: typeof fetch = fetch
) {
  if (principal.role === "admin") {
    return;
  }

  const portalUrl = env.PORTAL_URL?.trim().replace(/\/+$/, "");
  const cookie = request.headers.get("cookie");
  if (!portalUrl || !cookie) {
    throw new HttpError(403, "knowledge_admin_access_denied");
  }

  let response: Response;
  try {
    response = await fetchImpl(`${portalUrl}/api/auth/current-user`, {
      headers: { accept: "application/json", cookie }
    });
  } catch {
    throw new HttpError(503, "admin_authorization_source_unavailable");
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(403, "knowledge_admin_access_denied");
  }
  if (!response.ok) {
    throw new HttpError(503, "admin_authorization_source_unavailable");
  }

  const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  const user = payload && isRecord(payload.user) ? payload.user : undefined;
  if (!user) {
    throw new HttpError(503, "admin_authorization_source_unavailable");
  }

  const portalUserId = readString(user.id ?? user.userId).trim();
  const portalRole = readString(user.role).trim();
  if (portalUserId !== principal.sub || portalRole !== "admin") {
    throw new HttpError(403, "knowledge_admin_access_denied");
  }
}

export async function listAdminKnowledgeServices(env: Env, principal: Principal) {
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `
      SELECT
        knowledge_services.*,
        folder.path AS folder_path,
        folder.file_name AS folder_name,
        knowledge_namespaces.owner_user_id AS namespace_owner_user_id,
        COALESCE(profile.category, 'general') AS category,
        COALESCE(profile.tags_json, '[]') AS service_tags_json,
        COALESCE(profile.languages_json, '[]') AS languages_json,
        COALESCE(profile.feedback_enabled, 1) AS feedback_enabled,
        COALESCE(profile.feedback_policy_json, '{}') AS feedback_policy_json,
        COALESCE(profile.maintenance_team, '') AS maintenance_team,
        (
          SELECT COUNT(*)
          FROM knowledge_objects AS file
          WHERE file.namespace_id = knowledge_services.namespace_id
            AND file.object_kind = 'file'
            AND file.deleted_at IS NULL
            AND (
              file.parent_path = folder.path
              OR substr(file.parent_path, 1, length(folder.path) + 1) = folder.path || '/'
            )
        ) AS file_count
      FROM knowledge_services
      JOIN knowledge_namespaces ON knowledge_namespaces.id = knowledge_services.namespace_id
      JOIN knowledge_objects AS folder ON folder.id = knowledge_services.folder_object_id
      LEFT JOIN knowledge_service_profiles AS profile ON profile.service_id = knowledge_services.id
      WHERE knowledge_services.status = 'active'
        AND knowledge_services.agent_enabled = 1
        AND folder.deleted_at IS NULL
        AND knowledge_namespaces.org_id = ?
      ORDER BY knowledge_services.updated_at DESC, knowledge_services.id
      LIMIT 500
      `
    )
    .bind(principal.orgId)
    .all<AdminKnowledgeServiceRow>();
  const services = rows.results ?? [];
  const folderIds = services.map((service) => service.folder_object_id);
  const [permissions, ledgerActivity, shadowActivity] = await Promise.all([
    folderIds.length > 0
      ? env.KNOWLEDGE_DB
      .prepare(
        `
        SELECT
          permission.object_id,
          permission.subject_type,
          permission.subject_id,
          permission.role,
          provenance.grant_source,
          provenance.source_id
        FROM knowledge_permissions AS permission
        LEFT JOIN knowledge_permission_provenance AS provenance
          ON provenance.permission_id = permission.id
        WHERE permission.object_id IN (${folderIds.map(() => "?").join(", ")})
          AND permission.revoked_at IS NULL
          AND (permission.expires_at IS NULL OR datetime(permission.expires_at) > CURRENT_TIMESTAMP)
        ORDER BY permission.created_at, permission.id
        `
      )
      .bind(...folderIds)
      .all<AdminKnowledgePermissionRow>()
      : Promise.resolve({ results: [] as AdminKnowledgePermissionRow[] }),
    env.KNOWLEDGE_DB
      .prepare(
        `
        SELECT
          query_step.service_id,
          COUNT(*) AS request_count,
          MAX(query_step.created_at) AS last_active_at
        FROM knowledge_query_steps AS query_step
        JOIN knowledge_services AS service ON service.id = query_step.service_id
        JOIN knowledge_namespaces AS namespace
          ON namespace.id = service.namespace_id
        WHERE namespace.org_id = ?
        GROUP BY query_step.service_id
        `
      )
      .bind(principal.orgId)
      .all<AdminKnowledgeActivityRow>(),
    env.KNOWLEDGE_DB
      .prepare(
        `
        SELECT
          shadow_request.service_id,
          COUNT(*) AS request_count,
          MAX(shadow_request.created_at) AS last_active_at
        FROM knowledge_shadow_query_reports AS shadow_request
        JOIN knowledge_services AS service ON service.id = shadow_request.service_id
        JOIN knowledge_namespaces AS namespace ON namespace.id = service.namespace_id
        WHERE namespace.org_id = ?
        GROUP BY shadow_request.service_id
        `
      )
      .bind(principal.orgId)
      .all<AdminKnowledgeActivityRow>()
  ]);
  const permissionsByFolder = new Map<string, AdminKnowledgePermissionRow[]>();
  for (const permission of permissions.results ?? []) {
    if (!permission.object_id) continue;
    const current = permissionsByFolder.get(permission.object_id) ?? [];
    current.push(permission);
    permissionsByFolder.set(permission.object_id, current);
  }
  const ledgerActivityByService = new Map(
    (ledgerActivity.results ?? []).map((activity) => [activity.service_id, activity])
  );
  const shadowActivityByService = new Map(
    (shadowActivity.results ?? []).map((activity) => [activity.service_id, activity])
  );

  return services.map((service) => {
    const folderPermissions = permissionsByFolder.get(service.folder_object_id) ?? [];
    const ownerUserId = [...folderPermissions]
      .reverse()
      .find((permission) => permission.subject_type === "user" && canonicalPermissionRole(permission.role) === "owner")
      ?.subject_id || service.namespace_owner_user_id;
    const collaboratorUserIds = [...new Set(
      folderPermissions
        .filter((permission) => (
          permission.subject_type === "user"
          && canonicalPermissionRole(permission.role) === "collaborator"
          && permission.grant_source !== "knowledge_service"
        ))
        .map((permission) => permission.subject_id)
        .filter(Boolean)
    )].sort();
    const serviceViewerPermissions = folderPermissions.filter((permission) => (
      canonicalPermissionRole(permission.role) === "viewer"
      && permission.grant_source === "knowledge_service"
      && permission.source_id === service.id
    ));
    const access = {
      company: serviceViewerPermissions.some((permission) => permission.subject_type === "company"),
      departments: [...new Set(
        serviceViewerPermissions
          .filter((permission) => permission.subject_type === "department")
          .map((permission) => permission.subject_id)
      )].sort(),
      users: [...new Set(
        serviceViewerPermissions
          .filter((permission) => permission.subject_type === "user")
          .map((permission) => permission.subject_id)
      )].sort()
    };
    const permissionType = access.company
      ? "company"
      : access.departments.length > 0 || access.users.length > 0
        ? "targeted"
        : "private";
    const ledger = ledgerActivityByService.get(service.id);
    const shadow = shadowActivityByService.get(service.id);
    const lastActiveAt = [ledger?.last_active_at, shadow?.last_active_at]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);

    return {
      ...knowledgeServiceJson(service),
      access,
      collaboratorUserIds,
      fileCount: Number(service.file_count ?? 0),
      lastActiveAt,
      ownerUserId,
      permissionType,
      requestCount: ledger
        ? Number(ledger.request_count ?? 0)
        : Number(shadow?.request_count ?? 0)
    };
  }).filter((service) => service.permissionType !== "private");
}

type AdminKnowledgeServiceRow = KnowledgeServiceRow & {
  file_count: number;
  namespace_owner_user_id: string;
};

type AdminKnowledgeActivityRow = {
  last_active_at: string | null;
  request_count: number;
  service_id: string;
};

type AdminKnowledgePermissionRow = Pick<
  PermissionRow,
  "object_id" | "role" | "subject_id" | "subject_type"
> & {
  grant_source?: PermissionRow["grant_source"];
  source_id?: string;
};
