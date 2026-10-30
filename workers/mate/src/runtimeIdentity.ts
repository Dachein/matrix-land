import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import { RuntimeHttpError, type RuntimeEnv, type RuntimePrincipal } from "./types.ts";

export async function resolveEmailRuntimePrincipal(
  env: RuntimeEnv,
  email: string,
  callerKind: RuntimePrincipal["callerKind"] = "email_binding"
): Promise<RuntimePrincipal> {
  const serviceToken = env.MATE_AUTH_SERVICE_TOKEN?.trim();
  if (!serviceToken) throw new RuntimeHttpError(503, "mate_auth_service_token_not_configured");
  const origin = safeOrigin(env.AUTH_WORKER_URL || missingConfiguration("AUTH_WORKER_URL"));
  const request = new Request(`${origin}/v1/internal/mate/email-principal`, {
    body: JSON.stringify({ email: email.trim().toLowerCase() }),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });
  const response = env.AUTH_SERVICE ? await env.AUTH_SERVICE.fetch(request) : await fetch(request);
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) throw new RuntimeHttpError(403, "email_sender_not_active_workspace_user");
    throw new RuntimeHttpError(502, "email_identity_resolution_failed");
  }
  const user = record(payload.user);
  const userId = text(user.id);
  const orgId = text(payload.orgId);
  if (!userId || !orgId || text(user.status) !== "active") throw new RuntimeHttpError(403, "email_sender_not_active_workspace_user");
  return {
    callerKind,
    departmentId: text(user.departmentId) || undefined,
    departmentPath: stringArray(user.departmentPath),
    email: text(user.email) || email.trim().toLowerCase(),
    name: text(user.name) || undefined,
    orgId,
    orgSlug: text(payload.orgSlug) || undefined,
    scopes: ["mate:invoke", "mate:preferences"],
    userId
  };
}

export async function resolveUserRuntimePrincipal(
  env: RuntimeEnv,
  userId: string,
  callerKind: RuntimePrincipal["callerKind"] = "user"
): Promise<RuntimePrincipal> {
  const serviceToken = env.MATE_AUTH_SERVICE_TOKEN?.trim();
  if (!serviceToken) throw new RuntimeHttpError(503, "mate_auth_service_token_not_configured");
  const origin = safeOrigin(env.AUTH_WORKER_URL || missingConfiguration("AUTH_WORKER_URL"));
  const request = new Request(`${origin}/v1/internal/mate/user-principal`, {
    body: JSON.stringify({ userId }),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });
  const response = env.AUTH_SERVICE ? await env.AUTH_SERVICE.fetch(request) : await fetch(request);
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new RuntimeHttpError(response.status === 403 ? 403 : 502, "scheduled_user_resolution_failed");
  const user = record(payload.user);
  const resolvedUserId = text(user.id);
  const orgId = text(payload.orgId);
  if (!resolvedUserId || resolvedUserId !== userId || !orgId || text(user.status) !== "active") {
    throw new RuntimeHttpError(403, "scheduled_user_not_active");
  }
  return {
    callerKind,
    departmentId: text(user.departmentId) || undefined,
    departmentPath: stringArray(user.departmentPath),
    email: text(user.email) || undefined,
    name: text(user.name) || undefined,
    orgId,
    orgSlug: text(payload.orgSlug) || undefined,
    scopes: ["mate:invoke", "mate:preferences"],
    userId: resolvedUserId
  };
}

export function resolveScheduledRuntimePrincipal(env: RuntimeEnv, userId: string) {
  return resolveUserRuntimePrincipal(env, userId, "mate");
}

function safeOrigin(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error();
    return url.origin;
  } catch {
    throw new RuntimeHttpError(503, "auth_worker_url_invalid");
  }
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringArray(value: unknown) { return Array.isArray(value) ? value.map(text).filter(Boolean) : undefined; }
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
