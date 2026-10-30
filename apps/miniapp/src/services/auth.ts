/**
 * Authentication-boundary errors.
 *
 * A runtime session token (short-lived, per-Mate) and the Workspace web session
 * (long-lived, per-user) fail in different ways, and the mini-program must react
 * differently: the runtime token is silently renewed, while a lost web session can
 * only be recovered by sending the user back to the login page.
 */

/** The Workspace web session is gone (expired, revoked, or the user never bound WeChat). */
export class AuthRequiredError extends Error {
  code: string;

  constructor(code = "auth_required") {
    super(code);
    this.name = "AuthRequiredError";
    this.code = code;
  }
}

const AUTH_ERROR_CODES = new Set([
  "auth_required",
  "authentication_required",
  "not_authenticated",
  "unauthenticated",
  "session_expired",
  "session_invalid",
  "invalid_session",
  "wechat_binding_required",
  "miniapp_binding_required",
  "email_login_required"
]);

const AUTH_ERROR_MESSAGES = new Set([
  "auth_required",
  "unauthorized",
  "unauthenticated",
  "session_expired",
  "invalid_session",
  "not_authenticated"
]);

/**
 * Recognises a missing/expired Workspace web session. Runtime-session failures are
 * deliberately excluded — those are renewed in place and must never route the user
 * back to the login page.
 */
export function isAuthRequiredError(error: unknown) {
  if (error instanceof AuthRequiredError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code.toLowerCase() : "";
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase().trim() : "";
  // A runtime-session failure is renewed in place, so it never means "go log in again".
  if (code === "runtime_token_invalid" || message === "runtime_token_invalid") return false;
  if (AUTH_ERROR_CODES.has(code) || AUTH_ERROR_CODES.has(message) || AUTH_ERROR_MESSAGES.has(message)) return true;
  // A bare 401/403 without a more specific code still means the web session is gone.
  return candidate.status === 401 || candidate.status === 403;
}
