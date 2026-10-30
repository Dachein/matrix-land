import { type WorkspaceUser, HttpError } from "../../types.ts";
import { sanitizePath } from "../departments.ts";
import { normalizeEmail, optionalText, requiredText } from "../values.ts";
import { AUTH_USER_STATUSES, type AuthUserStatus } from "./types.ts";

// Normalize employee identity and merge authoritative snapshots.
export function mergeAuthUser(existing: WorkspaceUser | undefined, incoming: WorkspaceUser): WorkspaceUser {
  if (!existing) {
    return incoming;
  }

  const preserveMokaProfile = existing.source === "moka";
  const preserveCanonicalDepartment = preserveMokaProfile || (existing.source === "admin_import" && Boolean(existing.departmentId));
  return {
    ...existing,
    ...incoming,
    department: preserveCanonicalDepartment ? existing.department : incoming.department ?? existing.department,
    departmentId: preserveCanonicalDepartment ? existing.departmentId : incoming.departmentId ?? existing.departmentId,
    departmentPath: preserveCanonicalDepartment
      ? existing.departmentPath
      : incoming.departmentPath && incoming.departmentPath.length > 0 ? incoming.departmentPath : existing.departmentPath,
    email: incoming.email ?? existing.email,
    jobTitle: preserveMokaProfile ? existing.jobTitle : incoming.jobTitle ?? existing.jobTitle,
    name: preserveMokaProfile ? existing.name : incoming.name ?? existing.name,
    role: incoming.role ?? existing.role,
    status: incoming.status ?? existing.status,
    source: preserveMokaProfile ? existing.source : incoming.source ?? existing.source,
    team: incoming.team ?? existing.team,
    teamId: incoming.teamId ?? existing.teamId,
    teamPath: incoming.teamPath && incoming.teamPath.length > 0 ? incoming.teamPath : existing.teamPath
  };
}

export function mergeAuthLoginUser(existing: WorkspaceUser | undefined, incoming: WorkspaceUser): WorkspaceUser {
  if (!existing) {
    return incoming;
  }

  if (incoming.source === "moka") {
    return {
      ...existing,
      department: incoming.department,
      departmentId: incoming.departmentId,
      departmentPath: incoming.departmentPath ?? [],
      email: incoming.email,
      id: existing.id,
      jobTitle: incoming.jobTitle,
      name: incoming.name,
      role: existing.role ?? incoming.role,
      source: "moka",
      status: incoming.status,
      team: existing.team,
      teamId: existing.teamId,
      teamPath: existing.teamPath
    };
  }

  const preserveMokaProfile = existing.source === "moka";
  return {
    ...existing,
    department: preserveMokaProfile ? existing.department : existing.department ?? incoming.department,
    departmentId: preserveMokaProfile ? existing.departmentId : existing.departmentId ?? incoming.departmentId,
    departmentPath: preserveMokaProfile ? existing.departmentPath : existing.departmentPath && existing.departmentPath.length > 0 ? existing.departmentPath : incoming.departmentPath,
    email: existing.email ?? incoming.email,
    id: existing.id,
    jobTitle: preserveMokaProfile ? existing.jobTitle : existing.jobTitle ?? incoming.jobTitle,
    name: preserveMokaProfile ? existing.name : existing.name ?? incoming.name,
    role: existing.role ?? incoming.role,
    source: existing.source ?? incoming.source,
    status: incoming.status ?? existing.status,
    team: existing.team ?? incoming.team,
    teamId: existing.teamId ?? incoming.teamId,
    teamPath: existing.teamPath && existing.teamPath.length > 0 ? existing.teamPath : incoming.teamPath
  };
}

export function normalizeAuthUser(input: WorkspaceUser): WorkspaceUser {
  const departmentId = optionalText(input.departmentId, 180);
  const teamId = optionalText(input.teamId, 180);
  return {
    department: optionalText(input.department, 240),
    departmentId,
    departmentPath: sanitizePath(input.departmentPath, departmentId),
    email: normalizeEmail(input.email),
    id: requiredText(input.id || input.email, "missing_user_id", 180),
    jobTitle: optionalText(input.jobTitle, 240),
    name: optionalText(input.name, 240),
    role: normalizeAuthUserRole(input.role),
    source: optionalText(input.source, 80),
    status: normalizeUserStatus(input.status),
    team: optionalText(input.team, 240),
    teamId,
    teamPath: sanitizePath(input.teamPath, teamId)
  };
}

function normalizeAuthUserRole(value: unknown) {
  const role = optionalText(value, 80) ?? "member";
  if (role === "member" || role === "admin" || role === "auth_admin") {
    return role;
  }
  throw new HttpError(400, "invalid_user_role");
}

export function normalizeUserStatus(value: unknown): AuthUserStatus {
  const status = optionalText(value, 80);
  return isAuthUserStatus(status) ? status : "active";
}

export function normalizeUserStatusList(values: string[] | undefined) {
  const source = values && values.length > 0 ? values : ["active", "invited"];
  const statuses = Array.from(new Set(source.map(normalizeUserStatus)));
  return statuses.filter(isAuthUserStatus);
}

function isAuthUserStatus(value: unknown): value is AuthUserStatus {
  return typeof value === "string" && AUTH_USER_STATUSES.includes(value as AuthUserStatus);
}

export function emailLocalPart(value: unknown) {
  const email = normalizeEmail(value) ?? "";
  const atIndex = email.indexOf("@");
  return atIndex > 0 ? email.slice(0, atIndex) : "";
}
