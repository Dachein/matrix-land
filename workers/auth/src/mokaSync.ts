import { HttpError, type Env, type WorkspaceUser, type MokaDirectoryEvent } from "./types.ts";
import { isEmailAllowedByPolicy, readAuthEmailPolicy } from "../../../src/shared/authEmailPolicy.ts";
import { deliverUserInvitationSafely } from "./invitationEmail.ts";

type MokaDepartment = {
  active: boolean;
  externalId: string;
  name: string;
  parentExternalId?: string;
  path?: string[];
};

type MokaEmployee = {
  active: boolean;
  department?: string;
  departmentExternalId?: string;
  email: string;
  externalId: string;
  jobTitle?: string;
  name?: string;
  path?: string[];
};

type DepartmentLink = {
  department_id: string;
  external_id: string;
};

type UserRow = {
  id: string;
  email: string;
  role: string;
  status: string;
  team_id: string | null;
  team_name: string;
  team_path_json: string;
};

type MokaValidationExemptionRow = {
  email: string;
  skip_validation: number;
  reason: string;
  updated_at: string;
};

type MokaEmployeeSyncExclusionRow = {
  external_id: string;
  email: string;
  name: string;
  excluded: number;
  reason: string;
  updated_at: string;
};

export async function resolveMokaLoginUser(env: Env, input: WorkspaceUser) {
  if (env.MOKA_DIRECTORY_ENABLED !== "1") return { externalId: undefined, validationSkipped: false, user: input };
  const email = normalizeEmail(input.email);
  if (!email) throw new HttpError(403, "moka_work_email_required");
  if (!isEmailAllowedByPolicy(await readAuthEmailPolicy(env.AUTH_DB), email)) {
    throw new HttpError(403, "company_email_required");
  }
  const validationExemption = await env.AUTH_DB.prepare(`
    SELECT skip_validation FROM auth_moka_validation_exemptions WHERE email = ? LIMIT 1
  `).bind(email).first<{ skip_validation: number }>();
  if (validationExemption?.skip_validation === 1) {
    return { externalId: undefined, validationSkipped: true, user: input };
  }
  let employee: { employee: MokaEmployee };
  try {
    employee = await connectorRequest<{ employee: MokaEmployee }>(env, "/v1/employees/by-email", { email });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new HttpError(403, "moka_employee_not_found");
    }
    throw error;
  }
  if (!employee.employee || normalizeEmail(employee.employee.email) !== email) {
    throw new HttpError(502, "moka_employee_email_mismatch");
  }
  if (!employee.employee.active) throw new HttpError(403, "moka_employee_inactive");

  let department = await readDepartmentByExternalId(env, employee.employee.departmentExternalId);
  if (!department && employee.employee.departmentExternalId) {
    await syncMokaDepartments(env, "login_unknown_department");
    department = await readDepartmentByExternalId(env, employee.employee.departmentExternalId);
  }
  if (!department) throw new HttpError(503, "moka_department_unresolved");

  return {
    externalId: employee.employee.externalId,
    user: {
      ...input,
      department: department.name,
      departmentId: department.id,
      departmentPath: parseStringList(department.path_json),
      email,
      jobTitle: employee.employee.jobTitle,
      name: employee.employee.name ?? input.name,
      source: "moka",
      status: "active"
    } satisfies WorkspaceUser
  };
}

export async function listMokaValidationExemptions(env: Env) {
  const rows = await env.AUTH_DB.prepare(`
    SELECT email, skip_validation, reason, updated_at
    FROM auth_moka_validation_exemptions ORDER BY email
  `).all<MokaValidationExemptionRow>();
  return rows.results ?? [];
}

export async function setMokaValidationExemption(env: Env, input: { email: string; reason: string; skipValidation: boolean }) {
  const email = normalizeEmail(input.email);
  if (!email) throw new HttpError(400, "invalid_moka_exemption_email");
  const reason = String(input.reason || "").trim();
  if (!reason) throw new HttpError(400, "missing_moka_exemption_reason");
  await env.AUTH_DB.prepare(`
    INSERT INTO auth_moka_validation_exemptions (email, skip_validation, reason, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(email) DO UPDATE SET
      skip_validation = excluded.skip_validation,
      reason = excluded.reason,
      updated_at = CURRENT_TIMESTAMP
  `).bind(email, input.skipValidation ? 1 : 0, reason).run();
  return env.AUTH_DB.prepare(`
    SELECT email, skip_validation, reason, updated_at
    FROM auth_moka_validation_exemptions WHERE email = ? LIMIT 1
  `).bind(email).first<MokaValidationExemptionRow>();
}

export async function listMokaEmployeeSyncExclusions(env: Env) {
  const rows = await env.AUTH_DB.prepare(`
    SELECT external_id, email, name, excluded, reason, updated_at
    FROM auth_moka_employee_sync_exclusions ORDER BY name, external_id
  `).all<MokaEmployeeSyncExclusionRow>();
  return rows.results ?? [];
}

export async function setMokaEmployeeSyncExclusion(env: Env, input: {
  email?: string;
  employeeId: string;
  excluded: boolean;
  name?: string;
  reason: string;
}) {
  const externalId = String(input.employeeId || "").trim();
  const reason = String(input.reason || "").trim();
  if (!/^\d+$/.test(externalId)) throw new HttpError(400, "invalid_moka_employee_id");
  if (!reason) throw new HttpError(400, "missing_moka_exclusion_reason");
  const email = input.email ? normalizeEmail(input.email) : "";
  await env.AUTH_DB.prepare(`
    INSERT INTO auth_moka_employee_sync_exclusions (external_id, email, name, excluded, reason, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(external_id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      excluded = excluded.excluded,
      reason = excluded.reason,
      updated_at = CURRENT_TIMESTAMP
  `).bind(externalId, email, String(input.name || "").trim(), input.excluded ? 1 : 0, reason).run();
  return env.AUTH_DB.prepare(`
    SELECT external_id, email, name, excluded, reason, updated_at
    FROM auth_moka_employee_sync_exclusions WHERE external_id = ? LIMIT 1
  `).bind(externalId).first<MokaEmployeeSyncExclusionRow>();
}

export async function linkMokaLoginUser(env: Env, externalId: string | undefined, user: WorkspaceUser) {
  if (!externalId || !user.id) return;
  await upsertUserSource(env, {
    active: user.status !== "inactive",
    email: normalizeEmail(user.email),
    externalId,
    userId: user.id
  });
}

export async function syncMokaDepartments(
  env: Env,
  trigger: "login_unknown_department" | "manual" | "scheduled" | "webhook"
) {
  const runId = crypto.randomUUID();
  await startRun(env, runId, "department", trigger);
  try {
    const response = await connectorRequest<{ departments: MokaDepartment[] }>(env, "/v1/directory/departments", {});
    const departments = Array.isArray(response.departments) ? response.departments : [];
    const links = await readDepartmentLinks(env);
    const internalIds = new Map(links.map((link) => [link.external_id, link.department_id]));
    for (const department of departments) {
      if (!internalIds.has(department.externalId)) internalIds.set(department.externalId, `dept-${crypto.randomUUID()}`);
    }
    const byExternal = new Map(departments.map((department) => [department.externalId, department]));
    const statements: D1PreparedStatement[] = [];
    for (const department of departments) {
      const id = internalIds.get(department.externalId)!;
      const parentId = department.parentExternalId ? internalIds.get(department.parentExternalId) ?? null : null;
      const path = internalDepartmentPath(department, byExternal, internalIds);
      statements.push(env.AUTH_DB.prepare(`
        INSERT INTO auth_departments (id, name, parent_id, path_json, status, source, external_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'moka', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          parent_id = excluded.parent_id,
          path_json = excluded.path_json,
          status = excluded.status,
          source = 'moka',
          external_id = excluded.external_id,
          updated_at = CURRENT_TIMESTAMP
      `).bind(id, department.name, parentId, JSON.stringify(path), department.active ? "active" : "inactive", department.externalId));
      statements.push(env.AUTH_DB.prepare(`
        INSERT INTO auth_department_sources (source, external_id, department_id, source_status, last_seen_at, created_at, updated_at)
        VALUES ('moka', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(source, external_id) DO UPDATE SET
          department_id = excluded.department_id,
          source_status = excluded.source_status,
          last_seen_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      `).bind(department.externalId, id, department.active ? "active" : "inactive"));
    }
    await runBatches(env, statements);
    if (departments.length > 0) await deactivateMissingDepartments(env, departments.map((item) => item.externalId));
    await finishRun(env, runId, "succeeded", { seen: departments.length, updated: departments.length });
    return { runId, seen: departments.length, updated: departments.length };
  } catch (error) {
    await finishRun(env, runId, "failed", { errorCode: errorCode(error) }).catch(() => undefined);
    throw error;
  }
}

export async function syncMokaEmployees(
  env: Env,
  trigger: "manual" | "scheduled" | "webhook"
) {
  const runId = crypto.randomUUID();
  await startRun(env, runId, "employee", trigger);
  let finalized = false;
  let seen = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  try {
    const response = await connectorRequest<{ employees: MokaEmployee[]; filteredCount?: number }>(env, "/v1/directory/employees", {});
    const employees = Array.isArray(response.employees) ? response.employees : [];
    seen = employees.length + Math.max(0, Number(response.filteredCount) || 0);
    const exclusions = await listMokaEmployeeSyncExclusions(env);
    const excludedIds = new Set(exclusions.filter((row) => row.excluded === 1).map((row) => row.external_id));
    const eligibleEmployees = employees.filter((employee) => !excludedIds.has(employee.externalId));
    const unknownDepartments = new Set<string>();
    for (const employee of eligibleEmployees) {
      if (employee.active && employee.departmentExternalId && !(await readDepartmentByExternalId(env, employee.departmentExternalId))) {
        unknownDepartments.add(employee.departmentExternalId);
      }
    }
    if (unknownDepartments.size > 0) await syncMokaDepartments(env, trigger);

    skipped = seen - eligibleEmployees.length;
    for (const employee of eligibleEmployees) {
      try {
        const result = await upsertMokaEmployee(env, employee, false);
        result === "updated" ? updated += 1 : skipped += 1;
      } catch (error) {
        errors += 1;
        await env.AUTH_DB.prepare(`
          INSERT INTO auth_audit_events (
            id, action, resource_type, resource_id, decision, reason, metadata_json
          ) VALUES (?, 'moka_employee_sync_failed', 'moka_employee', ?, 'deny', ?, ?)
        `).bind(
          crypto.randomUUID(), employee.externalId, errorCode(error), JSON.stringify({ runId })
        ).run().catch(() => undefined);
      }
    }
    if (errors === 0 && seen > 0) {
      await deactivateMissingUsers(env, employees.map((item) => item.externalId));
    }
    await finishRun(env, runId, errors === 0 ? "succeeded" : "failed", {
      errorCode: errors === 0 ? undefined : "moka_employee_sync_partial_failure",
      errors,
      seen,
      skipped,
      updated
    });
    finalized = true;
    if (errors > 0) throw new HttpError(503, "moka_employee_sync_partial_failure");
    return { errors, runId, seen, skipped, updated };
  } catch (error) {
    if (!finalized) {
      await finishRun(env, runId, "failed", {
        seen, updated, skipped, errors: Math.max(1, errors), errorCode: errorCode(error)
      }).catch(() => undefined);
    }
    throw error;
  }
}

export async function runScheduledMokaDirectorySync(env: Env) {
  const departments = await syncMokaDepartments(env, "scheduled");
  const employees = await syncMokaEmployees(env, "scheduled");
  return { departments, employees };
}

export async function processMokaDirectoryEvent(env: Env, event: MokaDirectoryEvent) {
  const existing = await env.AUTH_DB.prepare(`
    SELECT status FROM auth_directory_events WHERE source = 'moka' AND event_key = ? LIMIT 1
  `).bind(event.eventKey).first<{ status: string }>();
  if (existing?.status === "succeeded") return;
  await env.AUTH_DB.prepare(`
    INSERT INTO auth_directory_events (
      source, event_key, entity_type, action, external_id, status, attempt_count, received_at, created_at, updated_at
    ) VALUES ('moka', ?, ?, ?, ?, 'processing', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(source, event_key) DO UPDATE SET
      status = 'processing',
      attempt_count = auth_directory_events.attempt_count + 1,
      error_code = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).bind(event.eventKey, event.entityType, event.action, event.sourceId, event.receivedAt).run();
  try {
    if (event.entityType === "department") {
      await syncMokaDepartments(env, "webhook");
    } else {
      try {
        const response = await connectorRequest<{ employee?: MokaEmployee; filtered?: boolean }>(env, "/v1/employees/by-id", {
          employeeId: event.sourceId
        });
        if (response.filtered) {
          await deactivateUserBySource(env, event.sourceId);
        } else if (response.employee) {
          await upsertMokaEmployee(env, response.employee, true);
        } else {
          throw new HttpError(502, "moka_employee_response_invalid");
        }
      } catch (error) {
        if (event.action === "deactivate" && error instanceof HttpError && error.code === "moka_employee_not_found") {
          await deactivateUserBySource(env, event.sourceId);
        } else {
          throw error;
        }
      }
    }
    await env.AUTH_DB.prepare(`
      UPDATE auth_directory_events SET status = 'succeeded', processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE source = 'moka' AND event_key = ?
    `).bind(event.eventKey).run();
  } catch (error) {
    await env.AUTH_DB.prepare(`
      UPDATE auth_directory_events SET status = 'failed', error_code = ?, updated_at = CURRENT_TIMESTAMP
      WHERE source = 'moka' AND event_key = ?
    `).bind(errorCode(error), event.eventKey).run().catch(() => undefined);
    throw error;
  }
}

async function upsertMokaEmployee(env: Env, employee: MokaEmployee, refreshUnknownDepartment: boolean) {
  const email = normalizeEmail(employee.email);
  const sourceLink = await env.AUTH_DB.prepare(`
    SELECT user_id FROM auth_user_sources WHERE source = 'moka' AND external_id = ? LIMIT 1
  `).bind(employee.externalId).first<{ user_id: string }>();
  const exclusion = await env.AUTH_DB.prepare(`
    SELECT excluded FROM auth_moka_employee_sync_exclusions WHERE external_id = ? LIMIT 1
  `).bind(employee.externalId).first<{ excluded: number }>();
  if (exclusion?.excluded === 1 && (employee.active || !sourceLink?.user_id)) return "skipped" as const;
  if (!email && !employee.active) {
    if (sourceLink?.user_id) {
      await setUserStatus(env, sourceLink.user_id, "inactive");
      await env.AUTH_DB.prepare(`
        UPDATE auth_user_sources
        SET source_status = 'inactive', last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE source = 'moka' AND external_id = ?
      `).bind(employee.externalId).run();
    }
    return "skipped" as const;
  }
  let department = await readDepartmentByExternalId(env, employee.departmentExternalId);
  if (!department && employee.active && employee.departmentExternalId && refreshUnknownDepartment) {
    await syncMokaDepartments(env, "webhook");
    department = await readDepartmentByExternalId(env, employee.departmentExternalId);
  }
  if (employee.active && !department) throw new HttpError(503, "moka_department_unresolved");

  const emailUser = email ? await env.AUTH_DB.prepare(`
    SELECT id, email, role, status, team_id, team_name, team_path_json FROM auth_users WHERE lower(email) = lower(?) LIMIT 1
  `).bind(email).first<UserRow>() : undefined;
  const linkedUser = sourceLink?.user_id
    ? await env.AUTH_DB.prepare(`SELECT id, email, role, status, team_id, team_name, team_path_json FROM auth_users WHERE id = ? LIMIT 1`)
      .bind(sourceLink.user_id).first<UserRow>()
    : undefined;
  if (linkedUser && emailUser && linkedUser.id !== emailUser.id) throw new HttpError(409, "moka_employee_email_conflict");
  const existing = linkedUser ?? emailUser;
  const userId = existing?.id ?? `user-${crypto.randomUUID()}`;
  const status = !employee.active || !email
    ? "inactive"
    : !existing || !existing.email || existing.status === "invited"
      ? "invited"
      : existing.status === "suspended" ? "suspended" : "active";
  await env.AUTH_DB.prepare(`
    INSERT INTO auth_users (
      id, email, job_title, name, role, status, department_id, department_name, department_path_json,
      team_id, team_name, team_path_json, provider, provider_subject, source,
      first_seen_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, 'member', ?, ?, ?, ?, NULL, '', '[]', NULL, NULL, 'moka', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      job_title = excluded.job_title,
      name = excluded.name,
      status = excluded.status,
      department_id = excluded.department_id,
      department_name = excluded.department_name,
      department_path_json = excluded.department_path_json,
      source = 'moka',
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    userId,
    email,
    employee.jobTitle ?? "",
    employee.name ?? "",
    status,
    department?.id ?? null,
    department?.name ?? employee.department ?? "",
    department?.path_json ?? "[]"
  ).run();
  await upsertUserSource(env, { active: employee.active, email, externalId: employee.externalId, userId });
  if (department) {
    await env.AUTH_DB.prepare(`
      UPDATE auth_user_memberships
      SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND target_type = 'department' AND source = 'moka' AND target_id <> ?
    `).bind(userId, department.id).run();
    await env.AUTH_DB.prepare(`
      INSERT INTO auth_user_memberships (
        user_id, target_type, target_id, target_name, target_path_json, status, source, created_at, updated_at
      ) VALUES (?, 'department', ?, ?, ?, ?, 'moka', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, target_type, target_id) DO UPDATE SET
        target_name = excluded.target_name,
        target_path_json = excluded.target_path_json,
        status = excluded.status,
        source = 'moka',
        updated_at = CURRENT_TIMESTAMP
    `).bind(userId, department.id, department.name, department.path_json, employee.active ? "active" : "inactive").run();
  } else {
    await env.AUTH_DB.prepare(`
      UPDATE auth_user_memberships
      SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND target_type = 'department' AND source = 'moka'
    `).bind(userId).run();
  }
  if (status === "invited") await deliverUserInvitationSafely(env, userId);
  return "updated" as const;
}

async function connectorRequest<T>(env: Env, path: string, body: Record<string, unknown>): Promise<T> {
  if (!env.MOKA_CONNECTOR) throw new HttpError(503, "moka_connector_binding_not_configured");
  const token = env.MOKA_CONNECTOR_SERVICE_TOKEN?.trim();
  if (!token) throw new HttpError(503, "moka_connector_token_not_configured");
  let response: Response;
  try {
    response = await env.MOKA_CONNECTOR.fetch(`https://moka-connector.internal${path}`, {
      body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      method: "POST"
    });
  } catch {
    throw new HttpError(503, "moka_directory_unavailable");
  }
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    const status = response.status === 404 ? 404 : response.status === 409 ? 409 : 503;
    throw new HttpError(status, payload.error || "moka_directory_unavailable");
  }
  return payload;
}

async function readDepartmentByExternalId(env: Env, externalId: string | undefined) {
  if (!externalId) return undefined;
  return env.AUTH_DB.prepare(`
    SELECT d.id, d.name, d.path_json
    FROM auth_department_sources s
    JOIN auth_departments d ON d.id = s.department_id
    WHERE s.source = 'moka' AND s.external_id = ? AND s.source_status = 'active' AND d.status = 'active'
    LIMIT 1
  `).bind(externalId).first<{ id: string; name: string; path_json: string }>();
}

async function readDepartmentLinks(env: Env) {
  const result = await env.AUTH_DB.prepare(`
    SELECT external_id, department_id FROM auth_department_sources WHERE source = 'moka'
  `).all<DepartmentLink>();
  return result.results ?? [];
}

async function upsertUserSource(env: Env, input: { active: boolean; email: string; externalId: string; userId: string }) {
  await env.AUTH_DB.prepare(`
    INSERT INTO auth_user_sources (
      source, external_id, user_id, canonical_email, source_status, last_seen_at, created_at, updated_at
    ) VALUES ('moka', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(source, external_id) DO UPDATE SET
      user_id = excluded.user_id,
      canonical_email = excluded.canonical_email,
      source_status = excluded.source_status,
      last_seen_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).bind(input.externalId, input.userId, input.email, input.active ? "active" : "inactive").run();
}

function internalDepartmentPath(
  department: MokaDepartment,
  byExternal: Map<string, MokaDepartment>,
  internalIds: Map<string, string>
) {
  const result: string[] = [];
  const seen = new Set<string>();
  let current: MokaDepartment | undefined = department;
  while (current && !seen.has(current.externalId) && result.length < 32) {
    seen.add(current.externalId);
    const id = internalIds.get(current.externalId);
    if (id) result.unshift(id);
    current = current.parentExternalId ? byExternal.get(current.parentExternalId) : undefined;
  }
  return result;
}

async function runBatches(env: Env, statements: D1PreparedStatement[]) {
  for (let index = 0; index < statements.length; index += 50) {
    await env.AUTH_DB.batch(statements.slice(index, index + 50));
  }
}

async function deactivateMissingDepartments(env: Env, externalIds: string[]) {
  const idsJson = JSON.stringify(externalIds);
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare(`
      UPDATE auth_department_sources SET source_status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE source = 'moka' AND external_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
    `).bind(idsJson),
    env.AUTH_DB.prepare(`
      UPDATE auth_departments SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE id IN (
        SELECT department_id FROM auth_department_sources
        WHERE source = 'moka' AND external_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      )
    `).bind(idsJson)
  ]);
}

async function deactivateMissingUsers(env: Env, externalIds: string[]) {
  const idsJson = JSON.stringify(externalIds);
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare(`
      UPDATE auth_user_sources SET source_status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE source = 'moka' AND external_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
    `).bind(idsJson),
    env.AUTH_DB.prepare(`
      UPDATE auth_users SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE id IN (
        SELECT user_id FROM auth_user_sources
        WHERE source = 'moka' AND external_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      )
    `).bind(idsJson)
  ]);
}

async function deactivateUserBySource(env: Env, externalId: string) {
  const link = await env.AUTH_DB.prepare(`
    SELECT user_id FROM auth_user_sources WHERE source = 'moka' AND external_id = ? LIMIT 1
  `).bind(externalId).first<{ user_id: string }>();
  if (link?.user_id) await setUserStatus(env, link.user_id, "inactive");
  await env.AUTH_DB.prepare(`
    UPDATE auth_user_sources SET source_status = 'inactive', updated_at = CURRENT_TIMESTAMP
    WHERE source = 'moka' AND external_id = ?
  `).bind(externalId).run();
}

async function setUserStatus(env: Env, userId: string, status: "active" | "inactive") {
  await env.AUTH_DB.prepare(`UPDATE auth_users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(status, userId).run();
}

async function startRun(env: Env, id: string, entityType: string, trigger: string) {
  await env.AUTH_DB.prepare(`
    INSERT INTO auth_directory_sync_runs (
      id, source, entity_type, trigger_type, status, started_at, created_at, updated_at
    ) VALUES (?, 'moka', ?, ?, 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(id, entityType, trigger).run();
}

async function finishRun(env: Env, id: string, status: "succeeded" | "failed", counts: {
  errorCode?: string;
  errors?: number;
  seen?: number;
  skipped?: number;
  updated?: number;
}) {
  await env.AUTH_DB.prepare(`
    UPDATE auth_directory_sync_runs
    SET status = ?, seen_count = ?, updated_count = ?, skipped_count = ?, error_count = ?,
        error_code = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    status,
    counts.seen ?? 0,
    counts.updated ?? 0,
    counts.skipped ?? 0,
    counts.errors ?? 0,
    counts.errorCode ?? null,
    id
  ).run();
}

function normalizeEmail(value: unknown) {
  const email = String(value ?? "").trim().toLowerCase();
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function parseStringList(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function errorCode(error: unknown) {
  return error instanceof HttpError ? error.code : error instanceof Error ? error.message.slice(0, 180) : "moka_sync_failed";
}
