export const APPS_RESERVED_APP_CODE_PREFIXES = [
  "auth",
  "cf",
  "d1",
  "workspace",
  "apps",
  "sqlite",
  "users"
] as const;

const APPS_RESERVED_APP_CODES = new Set([
  "admin",
  "ai",
  "api",
  "app",
  "apps",
  "auth",
  "cdn",
  "dashboard",
  "k",
  "knowledge",
  "apps",
  "live",
  "mcp",
  "static",
  "support",
  "token",
  "www"
]);

export function isReservedAppsAppCode(value: string) {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  return APPS_RESERVED_APP_CODES.has(normalized)
    || APPS_RESERVED_APP_CODE_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`));
}
