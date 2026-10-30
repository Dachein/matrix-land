import type { Env, WorkspaceUser } from "../types.ts";
import { jsonStringList, normalizeActiveStatus, optionalText, requireDb, requiredText, stringList } from "./values.ts";

// Department hierarchy and primary organizational memberships.
type AuthDepartmentRow = {
  external_id: string | null;
  id: string;
  name: string;
  parent_id: string | null;
  path_json: string;
  source: string;
  status: string;
};

type DepartmentInput = {
  externalId?: string;
  id?: string;
  name?: string;
  parentId?: string;
  path?: unknown;
  source?: string;
  status?: string;
};

type DepartmentResolutionContext = {
  email?: string;
  name?: string;
};

type ListAuthDepartmentsInput = {
  limit?: number;
  q?: string;
  statuses?: string[];
};


export async function upsertAuthDepartment(env: Env, input: DepartmentInput) {
  const db = requireDb(env);
  const department = {
    externalId: optionalText(input.externalId, 180),
    id: requiredText(input.id, "missing_department_id", 180),
    name: optionalText(input.name, 240) ?? "",
    parentId: optionalText(input.parentId, 180),
    path: stringList(input.path, 16, 180),
    source: optionalText(input.source, 80) ?? "portal",
    status: normalizeActiveStatus(input.status)
  };

  await db
    .prepare(
      `
      INSERT INTO auth_departments (
        id,
        name,
        parent_id,
        path_json,
        status,
        source,
        external_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        parent_id = excluded.parent_id,
        path_json = excluded.path_json,
        status = excluded.status,
        source = excluded.source,
        external_id = excluded.external_id,
        updated_at = CURRENT_TIMESTAMP
      `
    )
    .bind(
      department.id,
      department.name,
      department.parentId ?? null,
      JSON.stringify(department.path.length > 0 ? department.path : [department.id]),
      department.status,
      department.source,
      department.externalId ?? null
    )
    .run();

  return department;
}

/** Resolve an explicitly supplied directory path without guessing an organization. */
export async function resolveAuthDepartmentHierarchy(env: Env, value: unknown, _context: DepartmentResolutionContext = {}) {
  const path = String(value ?? "").trim();
  if (!path || !env.AUTH_DB) return undefined;
  const row = await readActiveDepartmentByExternalId(requireDb(env), path);
  return row ? departmentResolutionFromRow(row) : undefined;
}

export async function listAuthDepartments(env: Env, input: ListAuthDepartmentsInput = {}) {
  const db = requireDb(env);
  const statuses = Array.from(new Set((input.statuses ?? [])
    .map((status) => optionalText(status, 40))
    .filter((status): status is string => status === "active" || status === "inactive")));
  const filters: string[] = [];
  const binds: unknown[] = [];
  const query = optionalText(input.q, 160);

  if (statuses.length > 0) {
    filters.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    binds.push(...statuses);
  }
  if (query) {
    filters.push("(lower(name) LIKE lower(?) OR lower(external_id) LIKE lower(?))");
    binds.push(`%${query}%`, `%${query}%`);
  }

  const rows = await db
    .prepare(
      `
      SELECT id, name, parent_id, path_json, status, external_id
      FROM auth_departments
      ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY json_array_length(path_json), lower(name), id
      LIMIT ?
      `
    )
    .bind(...binds, Math.min(Math.max(input.limit ?? 500, 1), 1000))
    .all<AuthDepartmentRow>();

  return (rows.results ?? []).map((row) => ({
    externalId: row.external_id ?? undefined,
    id: row.id,
    name: row.name,
    parentId: row.parent_id ?? undefined,
    path: jsonStringList(row.path_json),
    status: row.status === "inactive" ? "inactive" as const : "active" as const
  }));
}

export async function readAuthDepartmentDisplayPath(
  env: Env,
  user: Pick<WorkspaceUser, "departmentPath" | "source">
): Promise<string | undefined> {
  const path = (user.departmentPath ?? []).filter(Boolean);
  if (path.length === 0) return undefined;

  const rows = await requireDb(env)
    .prepare(`SELECT id, name FROM auth_departments WHERE status = 'active' AND id IN (${path.map(() => "?").join(", ")})`)
    .bind(...path)
    .all<{ id: string; name: string }>();
  const names = new Map((rows.results ?? []).map((row) => [row.id, row.name.trim()]));
  if (path.some((id) => !names.get(id))) return undefined;

  return path.map((id) => names.get(id)).join("/");
}

async function readActiveDepartmentByExternalId(db: D1Database, externalId: string) {
  return await db
    .prepare(
      `
      SELECT id, name, parent_id, path_json, status, source, external_id
      FROM auth_departments
      WHERE status = 'active' AND lower(external_id) = lower(?)
      ORDER BY CASE WHEN source = 'admin_import' THEN 0 ELSE 1 END, id
      LIMIT 1
      `
    )
    .bind(externalId)
    .first<AuthDepartmentRow>() ?? undefined;
}

function departmentResolutionFromRow(row: AuthDepartmentRow) {
  const department = row.external_id || row.name;
  return {
    department,
    departmentId: row.id,
    departmentPath: jsonStringList(row.path_json),
    parts: department.split("/").map((part) => part.trim()).filter(Boolean)
  };
}

export async function upsertPrimaryMemberships(env: Env, user: WorkspaceUser) {
  const db = requireDb(env);
  const statements: D1PreparedStatement[] = [];

  if (user.departmentId) {
    statements.push(db
      .prepare(
        `
        INSERT INTO auth_user_memberships (
          user_id,
          target_type,
          target_id,
          target_name,
          target_path_json,
          status,
          source,
          created_at,
          updated_at
        )
        VALUES (?, 'department', ?, ?, ?, 'active', 'auth_user_snapshot', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, target_type, target_id) DO UPDATE SET
          target_name = excluded.target_name,
          target_path_json = excluded.target_path_json,
          status = 'active',
          updated_at = CURRENT_TIMESTAMP
        `
      )
      .bind(user.id, user.departmentId, user.department ?? "", JSON.stringify(user.departmentPath ?? [])));
  }

  if (user.teamId) {
    statements.push(db
      .prepare(
        `
        INSERT INTO auth_user_memberships (
          user_id,
          target_type,
          target_id,
          target_name,
          target_path_json,
          status,
          source,
          created_at,
          updated_at
        )
        VALUES (?, 'team', ?, ?, ?, 'active', 'auth_user_snapshot', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, target_type, target_id) DO UPDATE SET
          target_name = excluded.target_name,
          target_path_json = excluded.target_path_json,
          status = 'active',
          updated_at = CURRENT_TIMESTAMP
        `
      )
      .bind(user.id, user.teamId, user.team ?? "", JSON.stringify(user.teamPath ?? [])));
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

export function sanitizePath(value: string[] | undefined, fallback?: string) {
  const parts = Array.isArray(value)
    ? value.map((part) => optionalText(part, 180)).filter(Boolean) as string[]
    : [];
  if (parts.length > 0) {
    return Array.from(new Set(parts));
  }
  return fallback ? [fallback] : [];
}
