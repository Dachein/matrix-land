/** Stable service labels; installations choose their DNS root and optional overrides. */
export const workspaceServicePrefixes = {
  auth: "auth", mcp: "mcp", apps: "apps", knowledge: "knowledge",
  live: "live", runtime: "mate", mail: "mail", stream: "stream",
  backup: "backup", miniapp: "miniapp-api", gateway: "gateway"
} as const;
export type WorkspaceService = keyof typeof workspaceServicePrefixes;
export type InstallationDomains = {
  portalHostname: string;
  serviceRoot: string;
  services: Record<WorkspaceService, string>;
  appHostPrefix: string;
  mateEmailDomain: string;
  appEmailDomain: string;
};

export function installationHostname(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_installation_hostname");
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) throw new Error("invalid_installation_hostname");
  const labels = host.split(".");
  if (labels.length < 2 || !/[a-z]/.test(labels.at(-1) || "") || labels.some((label) =>
    label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error("invalid_installation_hostname");
  }
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("invalid_installation_hostname");
  return host;
}

export function installationAppHostPrefix(value: unknown = "app-"): string {
  if (typeof value !== "string" || (value !== "" && !/^[a-z][a-z0-9-]{0,15}-$/.test(value))) {
    throw new Error("invalid_app_host_prefix");
  }
  return value;
}

export function resolveInstallationDomains(input: unknown): InstallationDomains {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_installation_domains");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["portalHostname", "serviceRoot", "services", "appHostPrefix", "mateEmailDomain", "appEmailDomain"].includes(key))) {
    throw new Error("unknown_installation_domain_field");
  }
  const portalHostname = installationHostname(value.portalHostname);
  const serviceRoot = installationHostname(value.serviceRoot);
  const overrides = value.services ?? {};
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)
    || Object.keys(overrides).some((key) => !Object.hasOwn(workspaceServicePrefixes, key))) throw new Error("invalid_service_hostnames");
  const services = Object.fromEntries(Object.entries(workspaceServicePrefixes).map(([key, prefix]) => [
    key, installationHostname((overrides as Record<string, unknown>)[key] ?? `${prefix}.${serviceRoot}`)
  ])) as Record<WorkspaceService, string>;
  const hosts = [portalHostname, ...Object.values(services)];
  if (new Set(hosts).size !== hosts.length) throw new Error("installation_hostname_collision");
  const appHostPrefix = installationAppHostPrefix(value.appHostPrefix);
  if (appHostPrefix && hosts.some((host) => host.endsWith(`.${serviceRoot}`)
    && host.slice(0, -(serviceRoot.length + 1)).startsWith(appHostPrefix))) throw new Error("app_hostname_namespace_collision");
  return { portalHostname, serviceRoot, services, appHostPrefix, mateEmailDomain: installationHostname(value.mateEmailDomain ?? `mate.${serviceRoot}`), appEmailDomain: installationHostname(value.appEmailDomain ?? `mail.${serviceRoot}`) };
}

export function installationDomainUrls(domains: InstallationDomains) {
  return {
    portal: `https://${domains.portalHostname}`,
    ...Object.fromEntries(Object.entries(domains.services).map(([key, host]) => [key, `https://${host}`]))
  } as Record<WorkspaceService | "portal", string>;
}

/** Only fields explicitly needed by the browser. No bindings, IDs, or credentials. */
export type PublicInstallationEndpoints = {
  appBaseDomain?: string;
  appHostPrefix?: string;
  mcpUrl?: string;
  mateEmailDomain?: string;
  appEmailDomain?: string;
};
export function publicInstallationEndpoints(env: { APPS_BASE_DOMAIN?: string; APPS_APP_HOST_PREFIX?: string; MCP_RESOURCE_URL?: string; WORKSPACE_MATE_EMAIL_DOMAIN?: string; WORKSPACE_EMAIL_ROUTING_DOMAIN?: string }): PublicInstallationEndpoints {
  const appBaseDomain = env.APPS_BASE_DOMAIN ? installationHostname(env.APPS_BASE_DOMAIN) : undefined;
  let mcpUrl: string | undefined;
  if (env.MCP_RESOURCE_URL) {
    const url = new URL(env.MCP_RESOURCE_URL);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash || !["/", "/mcp"].includes(url.pathname)) throw new Error("invalid_mcp_url");
    installationHostname(url.hostname);
    mcpUrl = url.origin;
  }
  return { ...(env.WORKSPACE_MATE_EMAIL_DOMAIN ? {mateEmailDomain: installationHostname(env.WORKSPACE_MATE_EMAIL_DOMAIN)} : {}), ...(env.WORKSPACE_EMAIL_ROUTING_DOMAIN ? {appEmailDomain: installationHostname(env.WORKSPACE_EMAIL_ROUTING_DOMAIN)} : {}), ...(appBaseDomain ? { appBaseDomain, appHostPrefix: installationAppHostPrefix(env.APPS_APP_HOST_PREFIX ?? "") } : {}), ...(mcpUrl ? { mcpUrl } : {}) };
}
