import type { AppSnapshot, Env, Principal } from "./types";
import { isAppOwnerOrAdmin } from "./access";
import { HttpError } from "./types";

export async function resolvePrincipal(request: Request, env: Env): Promise<Principal> {
  if (env.DEV_AUTH_BYPASS === "1" && isLocal(request)) {
    return {
      sub: request.headers.get("x-workspace-user-id") || "local.backup@example.invalid",
      email: request.headers.get("x-workspace-user-email") || undefined,
      orgId: request.headers.get("x-workspace-org-id") || "example-org",
      role: request.headers.get("x-workspace-role") || "admin"
    };
  }
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const secret = env.BACKUP_PORTAL_JWT_SECRET?.trim();
  if (!token) throw new HttpError(401, "missing_backup_token");
  if (!secret) throw new HttpError(503, "backup_portal_jwt_secret_not_configured");
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "invalid_backup_token");
  const signed = `${parts[0]}.${parts[1]}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, base64UrlBytes(parts[2]), new TextEncoder().encode(signed));
  if (!valid) throw new HttpError(401, "invalid_backup_token_signature");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[1]))) as Record<string, unknown>;
  } catch {
    throw new HttpError(401, "invalid_backup_token_payload");
  }
  if (Number(payload.exp) < Math.floor(Date.now() / 1000)) throw new HttpError(401, "backup_token_expired");
  const sub = text(payload.sub);
  const orgId = text(payload.org_id || payload.orgId);
  if (!sub || !orgId) throw new HttpError(401, "invalid_backup_token_claims");
  return { sub, email: text(payload.email) || undefined, orgId, role: text(payload.platform_role || payload.role) || "user" };
}

export async function requireAppAccess(env: Env, principal: Principal, appId: string): Promise<AppSnapshot> {
  const row = await env.APPS_DB.prepare("SELECT * FROM apps_apps WHERE id = ? AND org_id = ? LIMIT 1").bind(appId, principal.orgId).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "apps_app_not_found");
  const ownerUserId = text(row.owner_user_id);
  const collaborators = parseArray(row.collaborator_user_ids_json);
  const aliases = [principal.sub, principal.email].filter((value): value is string => Boolean(value));
  if (principal.role !== "admin" && !aliases.includes(ownerUserId) && !collaborators.some((value) => aliases.includes(value))) {
    throw new HttpError(404, "apps_app_not_found");
  }
  const resourceRows = await env.APPS_DB
    .prepare("SELECT id, type, resource_id, resource_name, status FROM apps_app_resources WHERE app_id = ? AND environment = 'prod' AND type IN ('d1_database', 'r2_bucket') ORDER BY type")
    .bind(appId)
    .all<Record<string, unknown>>();
  return {
    id: appId,
    orgId: text(row.org_id),
    name: text(row.name),
    code: text(row.code || row.slug),
    ownerUserId,
    collaboratorUserIds: collaborators,
    resources: (resourceRows.results ?? []).map((resource) => ({
      id: text(resource.id),
      type: text(resource.type) as "d1_database" | "r2_bucket",
      resourceId: text(resource.resource_id),
      resourceName: text(resource.resource_name),
      status: text(resource.status)
    }))
  };
}

export function requireAppOwner(principal: Principal, app: AppSnapshot) {
  if (!isAppOwnerOrAdmin(principal, app.ownerUserId)) {
    throw new HttpError(403, "app_owner_required");
  }
}

export function requireAdmin(principal: Principal) {
  if (principal.role !== "admin") throw new HttpError(403, "admin_required");
}

function base64UrlBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseArray(value: unknown) {
  try {
    const parsed = JSON.parse(text(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function isLocal(request: Request) {
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
}
