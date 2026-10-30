import { resolveAuthoritativeAuthUserSnapshot } from "../repositories/users/login.ts";
import { requireServiceToken } from "../serviceAuthorization.ts";
import { cookieValue } from "../session/cookies.ts";
import { verifyAuthToken } from "../token.ts";
import { type Env, type WorkspaceUser, HttpError } from "../types.ts";
import { headerValue, normalizeRole, readHeaderPath, readOptionalString, readString, readStringList } from "../values.ts";

// Resolve session/header identity separately from app/resource permission policy.
export async function resolveRequestUser(request: Request, env: Env, bodyUser?: WorkspaceUser) {
  if (bodyUser) {
    requireServiceToken(request, env);
    return resolveAuthoritativeAuthUserSnapshot(env, normalizeUser(bodyUser));
  }

  return resolveAuthoritativeAuthUserSnapshot(env, resolveUserFromHeaders(request));
}

export function resolveUserFromHeaders(request: Request) {
  const user = normalizeUser({
    departmentId: headerValue(request, "x-workspace-department-id"),
    departmentPath: readHeaderPath(request, "x-workspace-department-path"),
    id: headerValue(request, "x-workspace-user-id") || headerValue(request, "x-workspace-provider-subject-id") || headerValue(request, "x-workspace-entra-object-id") || "",
    email: headerValue(request, "x-workspace-user-email") || request.headers.get("cf-access-authenticated-user-email") || undefined,
    jobTitle: "",
    name: headerValue(request, "x-workspace-user-name"),
    role: headerValue(request, "x-workspace-role"),
    teamId: headerValue(request, "x-workspace-team-id"),
    teamPath: readHeaderPath(request, "x-workspace-team-path"),
    team: headerValue(request, "x-workspace-team-name"),
    department: headerValue(request, "x-workspace-department"),
    status: headerValue(request, "x-workspace-user-status") || "active"
  });

  if (!user.id) {
    throw new HttpError(401, "not_authenticated");
  }

  return user;
}

export async function resolveAuthorizeUser(request: Request, env: Env) {
  const sessionToken = cookieValue(request, "workspace_session");
  if (!sessionToken) {
    return undefined;
  }

  try {
    const payload = await verifyAuthToken(env, sessionToken);
    return userFromSessionPayload(payload, env);
  } catch {
    return undefined;
  }
}

export function normalizeUser(user: WorkspaceUser) {
  const id = readString(user.id || user.email);
  return {
    departmentId: readOptionalString(user.departmentId),
    departmentPath: Array.isArray(user.departmentPath) ? user.departmentPath.map(String).filter(Boolean) : [],
    id,
    email: readOptionalString(user.email),
    jobTitle: readOptionalString(user.jobTitle),
    name: readOptionalString(user.name),
    role: readOptionalString(user.role) ?? "member",
    source: readOptionalString(user.source),
    teamId: readOptionalString(user.teamId),
    teamPath: Array.isArray(user.teamPath) ? user.teamPath.map(String).filter(Boolean) : [],
    team: readOptionalString(user.team),
    department: readOptionalString(user.department),
    status: readOptionalString(user.status) ?? "active"
  };
}

export function userFromTokenPayload(payload: Record<string, unknown>) {
  return normalizeUser({
    departmentId: readOptionalString(payload.department_id ?? payload.departmentId),
    departmentPath: readStringList(payload.department_path ?? payload.departmentPath),
    id: readString(payload.sub),
    email: readOptionalString(payload.email),
    jobTitle: "",
    name: readOptionalString(payload.name),
    role: readOptionalString(payload.role),
    teamId: readOptionalString(payload.team_id ?? payload.teamId),
    teamPath: readStringList(payload.team_path ?? payload.teamPath),
    team: readOptionalString(payload.team),
    department: readOptionalString(payload.department),
    status: "active"
  });
}

export function readUserFromBody(value: unknown): WorkspaceUser | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const row = value as Record<string, unknown>;
  return {
    departmentId: readOptionalString(row.departmentId ?? row.department_id),
    departmentPath: readStringList(row.departmentPath ?? row.department_path),
    id: readString(row.id),
    email: readOptionalString(row.email),
    jobTitle: "",
    name: readOptionalString(row.name),
    role: readOptionalString(row.role),
    teamId: readOptionalString(row.teamId ?? row.team_id),
    teamPath: readStringList(row.teamPath ?? row.team_path),
    team: readOptionalString(row.team),
    department: readOptionalString(row.department),
    status: readOptionalString(row.status)
  };
}

export function readUserSnapshotFromBody(body: Record<string, unknown>): WorkspaceUser {
  return normalizeUser({
    department: readOptionalString(body.department ?? body.departmentName ?? body.department_name),
    departmentId: readOptionalString(body.departmentId ?? body.department_id),
    departmentPath: readStringList(body.departmentPath ?? body.department_path),
    email: readOptionalString(body.email),
    id: readString(body.id ?? body.userId ?? body.user_id ?? body.sub),
    jobTitle: "",
    name: readOptionalString(body.name),
    role: readOptionalString(body.role),
    status: readOptionalString(body.status),
    team: readOptionalString(body.team ?? body.teamName ?? body.team_name),
    teamId: readOptionalString(body.teamId ?? body.team_id),
    teamPath: readStringList(body.teamPath ?? body.team_path)
  });
}

export function readUserSnapshotInputFromBody(body: Record<string, unknown>, defaultStatus?: string) {
  const user = readUserSnapshotFromBody(body);

  return {
    ...user,
    provider: readOptionalString(body.provider),
    providerSubject: readOptionalString(body.providerSubject ?? body.provider_subject),
    source: readOptionalString(body.source) ?? "admin_import",
    status: readOptionalString(body.status) ?? defaultStatus ?? user.status
  };
}

export function userFromSessionPayload(payload: Record<string, unknown>, env: Env) {
  if (payload.typ !== "workspace_session") {
    return undefined;
  }

  const userId = readString(payload.sub);
  const objectId = readString(payload.oid) || userId;
  const email = readString(payload.email);

  if (!userId || !objectId || !email) {
    return undefined;
  }

  return {
    id: userId,
    name: readString(payload.name) || email.split("@")[0],
    email,
    avatarUrl: readOptionalString(payload.avatarUrl),
    team: readString(payload.team) || env.DEFAULT_TEAM_NAME || "AI Adoption",
    department: readOptionalString(payload.department),
    departmentId: readOptionalString(payload.department_id ?? payload.departmentId),
    departmentPath: readStringList(payload.department_path ?? payload.departmentPath),
    jobTitle: "",
    role: normalizeRole(payload.role),
    identity: {
      authenticationMethod: normalizeAuthenticationMethod(payload.authenticationMethod, payload.amr),
      provider: readString(payload.provider) || "microsoft_entra_id",
      tenantId: readString(payload.tid) || env.ENTRA_TENANT_ID || "",
      objectId,
      principalName: readString(payload.principalName) || email
    }
  };
}

export function normalizeCanonicalIdentityProvider(value: unknown) {
  const provider = readString(value);
  return provider === "microsoft_entra_id" || provider === "dingtalk" || provider === "generic_oidc"
    ? provider
    : "generic_oidc";
}

function normalizeAuthenticationMethod(value: unknown, amr: unknown) {
  const direct = readString(value);
  if (direct === "email_otp" || direct === "microsoft_entra_id" || direct === "wechat_miniapp") {
    return direct;
  }
  const methods = Array.isArray(amr) ? amr.map(String) : [];
  if (methods.includes("email_otp")) {
    return "email_otp";
  }
  return methods.includes("microsoft_entra_id") ? "microsoft_entra_id" : undefined;
}

export async function requireAuthoritativeSessionUser(request: Request, env: Env) {
  const sessionUser = await resolveAuthorizeUser(request, env);
  if (!sessionUser) throw new HttpError(401, "not_authenticated");
  const user = await resolveAuthoritativeAuthUserSnapshot(env, sessionUser);
  if (!user || user.status !== "active") throw new HttpError(403, "auth_user_inactive");
  return user;
}
