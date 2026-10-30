import { type Env, HttpError } from "./types.ts";
import { readOptionalString } from "./values.ts";

// Resolve Auth configuration and TTLs at the operation boundary.
export function issuer(env: Env) {
  return (env.AUTH_ISSUER || requireConfiguration("AUTH_ISSUER")).replace(/\/$/, "");
}

export function authPublicUrl(env: Env) {
  return (env.AUTH_PUBLIC_URL || env.PORTAL_URL || issuer(env)).replace(/\/+$/, "");
}

export function authPublicUrlFromRequest(request: Request) {
  const origin = request.headers.get("x-workspace-public-origin");
  return (origin || new URL(request.url).origin).replace(/\/+$/, "");
}

export function isEntraAuthConfigured(env: Env) {
  return Boolean(env.ENTRA_TENANT_ID && env.ENTRA_CLIENT_ID && env.ENTRA_CLIENT_SECRET);
}

export function requireEntraAuthConfig(env: Env, request: Request) {
  const tenantId = readOptionalString(env.ENTRA_TENANT_ID);
  const clientId = readOptionalString(env.ENTRA_CLIENT_ID);
  const clientSecret = readOptionalString(env.ENTRA_CLIENT_SECRET);

  if (!tenantId || !clientId || !clientSecret || ["common", "organizations", "consumers"].includes(tenantId)) {
    throw new HttpError(503, "entra_oauth_not_configured");
  }

  return {
    authority: normalizeEntraAuthority(env.ENTRA_AUTHORITY, tenantId),
    clientId,
    clientSecret,
    redirectUri: readOptionalString(env.ENTRA_REDIRECT_URI) ?? new URL("/auth/entra/callback", authPublicUrl(env)).toString(),
    scopes: readOptionalString(env.ENTRA_SCOPES) ?? "openid profile email",
    tenantId
  };
}

function normalizeEntraAuthority(value: string | undefined, tenantId: string) {
  return (value?.trim() || `https://login.microsoftonline.com/${tenantId}`)
    .replace(/\/+$/, "")
    .replace(/\/v2\.0$/, "");
}

export function getSessionTtlSeconds(env: Env) {
  const parsed = Number.parseInt(env.SESSION_TTL_SECONDS ?? "604800", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 604800;
}

export function configuredMcpIdleTtlSeconds(env: Env) {
  const parsed = Number.parseInt(env.MCP_IDLE_TTL_SECONDS ?? "604800", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 604800;
}

export function mcpOAuthAccessTokenTtlSeconds(env: Env) {
  const parsed = Number.parseInt(env.MCP_ACCESS_TOKEN_TTL_SECONDS ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(parsed, 24 * 60 * 60);
  }
  return 60 * 60;
}

export function authCodeTtlSeconds(env: Env) {
  const parsed = Number.parseInt(env.AUTH_CODE_TTL_SECONDS ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return 300;
}

export function resourceTokenTtlSeconds(env: Env) {
  const parsed = Number.parseInt(env.RESOURCE_TOKEN_TTL_SECONDS ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return 300;
}

function requireConfiguration(name: string): never { throw new HttpError(503, `${name.toLowerCase()}_not_configured`); }
