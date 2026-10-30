import type { AccessAction, AppAccessInput, AppAccessResult, WorkspaceUser } from "./types.ts";

const POLICY_VERSION = "app-access-v1";
export type AppSystemRole = "app_owner" | "app_collaborator";

export function resolveAppSystemRoles(
  app: Pick<AppAccessInput["app"], "businessOwnerUserId" | "publisherUserId"> & { collaboratorUserIds?: string[] },
  user: WorkspaceUser,
): AppSystemRole[] {
  if (isAppOwner({ app, user } as AppAccessInput)) return ["app_owner"];
  return identifierListMatchesUser(app.collaboratorUserIds ?? [], user) ? ["app_collaborator"] : [];
}

export function evaluateAppAccess(input: AppAccessInput): AppAccessResult {
  const action = input.action ?? "launch";
  const appId = input.app.id;
  const user = input.user;

  if (!user.id) {
    return deny(action, appId, "denied_not_authenticated");
  }

  if (user.status && user.status !== "active") {
    return deny(action, appId, "denied_user_inactive");
  }

  if (input.app.status && input.app.status !== "listed") {
    if (isAdmin(user)) {
      return allow(action, appId, "allowed_admin_prelist_preview");
    }
    if (input.app.sdkStatus && input.app.sdkStatus !== "connected" && action !== "visibility") {
      return deny(action, appId, "denied_app_sdk_not_connected");
    }
    if (isAppOwner(input)) {
      return allow(action, appId, "allowed_owner_prelist_preview");
    }
    if (input.app.accessMode === "targeted" && targetMatchesUser(input.app.accessTargets ?? [], user)) {
      return allow(action, appId, "allowed_target_prelist_preview");
    }
    return deny(action, appId, "denied_app_not_listed");
  }

  if (input.app.sdkStatus && input.app.sdkStatus !== "connected" && action !== "visibility") {
    return deny(action, appId, "denied_app_sdk_not_connected");
  }

  if (isAppOwner(input)) {
    return allow(action, appId, "allowed_owner");
  }

  const mode = input.app.accessMode ?? "public";

  if (mode === "public") {
    return allow(action, appId, "allowed_public");
  }

  if (mode === "request") {
    if (input.grantStatus === "approved") {
      return allow(action, appId, "allowed_approved_grant");
    }

    return action === "visibility"
      ? allow(action, appId, "allowed_requestable")
      : deny(action, appId, "denied_pending_approval");
  }

  if (targetMatchesUser(input.app.accessTargets ?? [], user)) {
    return allow(action, appId, "allowed_target_match");
  }

  return deny(action, appId, "denied_not_targeted");
}

function allow(action: AccessAction, appId: string, reason: string): AppAccessResult {
  return {
    action,
    appId,
    decision: "allow",
    policyVersion: POLICY_VERSION,
    reason
  };
}

function deny(action: AccessAction, appId: string, reason: string): AppAccessResult {
  return {
    action,
    appId,
    decision: "deny",
    policyVersion: POLICY_VERSION,
    reason
  };
}

function isAdmin(user: WorkspaceUser) {
  return user.role === "admin" || user.role === "auth_admin";
}

function isAppOwner(input: AppAccessInput) {
  return identifierListMatchesUser([
    input.app.publisherUserId,
    input.app.businessOwnerUserId,
  ].filter((value): value is string => Boolean(value)), input.user);
}

function identifierListMatchesUser(identifiers: string[], user: WorkspaceUser) {
  const candidates = new Set([user.id, user.email]
    .map(normalizeTargetValue)
    .filter(Boolean));
  return identifiers.some((identifier) => candidates.has(normalizeTargetValue(identifier)));
}

function targetMatchesUser(targets: string[], user: WorkspaceUser) {
  const userDepartments = targetLineage(user.departmentId, user.departmentPath);

  return targets.some((target) => {
    const normalized = target.trim().toLowerCase();

    if (!normalized) {
      return false;
    }

    if (normalized.startsWith("user:")) {
      return normalizeTargetValue(normalized.slice("user:".length)) === normalizeTargetValue(user.id);
    }

    if (normalized.startsWith("department:")) {
      return targetPathMatches(userDepartments, normalized.slice("department:".length));
    }

    return false;
  });
}

function targetLineage(id: string | undefined, path: string[] | undefined) {
  return Array.from(new Set([
    normalizeTargetValue(id),
    ...(path ?? []).map(normalizeTargetValue)
  ].filter(Boolean)));
}

function targetPathMatches(userTargets: string[], target: string) {
  const normalizedTarget = normalizeDepartmentPath(target);
  if (!normalizedTarget) {
    return false;
  }

  return userTargets.some((value) => value === normalizedTarget || value.startsWith(`${normalizedTarget}/`));
}

function normalizeDepartmentPath(value: string) {
  return value
    .split("/")
    .map(normalizeTargetValue)
    .filter(Boolean)
    .join("/");
}

function normalizeTargetValue(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}
