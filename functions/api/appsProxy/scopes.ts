export const APPS_ALLOWED_SCOPES = [
  "apps:apps:read",
  "apps:apps:write",
  "apps:apps:admin",
  "apps:skills:read",
  "apps:skills:write",
  "apps:skills:admin",
  "apps:mates:read",
  "apps:mates:write",
  "apps:mates:admin",
  "apps:secrets:write",
  "apps:deploy:production"
];

export const APPS_READ_SCOPES = ["apps:apps:read", "apps:skills:read"];
export const APPS_INVENTORY_READ_SCOPES = [...APPS_READ_SCOPES, "apps:mates:read"];

export function appsScopesForProxyRequest(method: string, upstreamPath: string) {
  // This scope is never client-selectable through /apps/token.
  if (upstreamPath.startsWith("/admin/ownership")) return ["apps:ownership:admin"];
  if ((method === "GET" || method === "HEAD") && upstreamPath === "/inventory") {
    return APPS_INVENTORY_READ_SCOPES;
  }

  if ((method === "GET" || method === "HEAD") && upstreamPath.startsWith("/mates")) {
    return ["apps:mates:read"];
  }

  if (method === "GET" || method === "HEAD") {
    return APPS_READ_SCOPES;
  }

  if (method === "POST" && /^\/apps\/[^/]+\/handoff-link$/.test(upstreamPath)) {
    return ["apps:apps:read"];
  }

  if (upstreamPath.includes("/secrets")) {
    return sanitizeAppsScopes(["apps:secrets:write", "apps:apps:read"], APPS_READ_SCOPES);
  }

  if (upstreamPath.startsWith("/skills")) {
    return sanitizeAppsScopes(["apps:skills:write", "apps:skills:admin", "apps:skills:read"], APPS_READ_SCOPES);
  }

  if (upstreamPath.startsWith("/mates")) {
    return sanitizeAppsScopes(["apps:mates:write", "apps:mates:admin", "apps:mates:read"], APPS_READ_SCOPES);
  }

  if (upstreamPath.endsWith("/publish")) {
    return sanitizeAppsScopes(["apps:deploy:production", "apps:apps:admin", "apps:apps:read"], APPS_READ_SCOPES);
  }

  return sanitizeAppsScopes(["apps:apps:write", "apps:apps:admin", "apps:apps:read"], APPS_READ_SCOPES);
}

export function sanitizeAppsScopes(value: unknown, fallback: string[]) {
  const requested = Array.isArray(value)
    ? value.map((scope) => readString(scope).trim()).filter(Boolean)
    : [];
  const allowed = new Set(APPS_ALLOWED_SCOPES);
  const scopes = requested.filter((scope) => allowed.has(scope));
  return scopes.length > 0 ? Array.from(new Set(scopes)) : fallback;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}
