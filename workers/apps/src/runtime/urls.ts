import { installationHostname, installationAppHostPrefix } from "../../../../src/shared/installationDomains";
import { HttpError } from "../core/types";
import { normalizeAppCode } from "../core/utils";
import type { Env } from "../core/types";

export type RuntimeUrls = {
  productionUrl: string;
};

export function runtimeUrls(env: Env, appCode: string): RuntimeUrls {
  const code = normalizeAppCode(appCode);
  const mode = readString(env.APPS_RUNTIME_HOST_MODE).trim();

  if (mode === "path") {
    return fallbackRuntimeUrls(env, code);
  }

  const domain = baseDomain(env);
  const prefix = installationAppHostPrefix(env.APPS_APP_HOST_PREFIX ?? "");
  if (`${prefix}${code}`.length > 63) throw new HttpError(400, "app_code_too_long_for_domain");

  return {
    productionUrl: `https://${prefix}${code}.${domain}`
  };
}

export function fallbackRuntimeUrls(env: Env, appCode: string): RuntimeUrls {
  const origin = platformOrigin(env);
  const code = normalizeAppCode(appCode);

  return {
    productionUrl: `${origin}/run/${code}`
  };
}

export function authIssuer(env: Env) {
  return (env.AUTH_ISSUER || "https://auth.workspace.internal").replace(/\/$/, "");
}

export function baseDomain(env: Env) {
  if (!env.APPS_BASE_DOMAIN) throw new HttpError(503, "app_domain_not_configured");
  return installationHostname(env.APPS_BASE_DOMAIN);
}

export function platformMcpUrl(env: Env) {
  if (!env.PLATFORM_MCP_URL) throw new HttpError(503, "apps_service_url_not_configured");
  const url = new URL(env.PLATFORM_MCP_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new HttpError(503, "invalid_apps_service_url");
  return url.toString();
}

export function platformOrigin(env: Env) {
  try {
    return new URL(platformMcpUrl(env)).origin;
  } catch {
    throw new HttpError(503, "apps_service_url_not_configured");
  }
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
