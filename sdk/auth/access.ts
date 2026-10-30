export const WORKSPACE_ACCESS_PAGE_PATH = "/auth/access";
export const WORKSPACE_ACCESS_RESULT_PARAM = "result";
export const WORKSPACE_ACCESS_RESULT_TYPE = "workspace_app_access_result";

export type WorkspacePublicAccessCode =
  | "ACCESS_NOT_GRANTED"
  | "ACCESS_PENDING"
  | "USER_INACTIVE"
  | "APP_UNAVAILABLE";

export function publicAccessCodeForReason(reason: string): WorkspacePublicAccessCode {
  if (reason === "denied_pending_approval") {
    return "ACCESS_PENDING";
  }
  if (reason === "denied_user_inactive" || reason === "auth_user_inactive" || reason === "auth_user_not_found") {
    return "USER_INACTIVE";
  }
  if (reason === "denied_app_not_listed" || reason === "denied_app_sdk_not_connected") {
    return "APP_UNAVAILABLE";
  }
  return "ACCESS_NOT_GRANTED";
}

export function buildWorkspaceAccessPageUrl(publicOrigin: string, accessResult: string) {
  const page = new URL(WORKSPACE_ACCESS_PAGE_PATH, requireHttpsOrLocalOrigin(publicOrigin));
  page.searchParams.set(WORKSPACE_ACCESS_RESULT_PARAM, accessResult);
  return page.toString();
}

function requireHttpsOrLocalOrigin(value: string) {
  const url = new URL(value);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password) {
    throw new Error("invalid_workspace_access_public_origin");
  }
  return url.origin;
}
