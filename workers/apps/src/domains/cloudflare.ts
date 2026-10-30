import { HttpError, type Env } from "../core/types";
import { readString } from "../core/utils";
import { cloudflareFetch, cloudflareOptionalFetch, requireCloudflareAccountId, requireCloudflareZoneId } from "../cloudflare/client";
import { baseDomain } from "../runtime/urls";
import type { AppsDomainRow, AppsResourceRow } from "../db/rows";

export type DomainStatusPatch = Partial<Record<"production", string>>;

type CloudflareDomainRuntime = {
  certificateStatus: string;
  checkedAt: string;
  dnsRecordId: string;
  provider: string;
  providerResourceId: string;
  routeId: string;
  routeStatus: string;
};

type CloudflareDnsRecord = {
  content: string;
  id: string;
  name: string;
  proxied?: boolean;
  type: string;
};

type CloudflareWorkerRoute = {
  id: string;
  pattern: string;
  script?: string | null;
};

type CloudflarePagesDomain = {
  domain_id?: string;
  id?: string;
  name?: string;
  status?: string;
  validation_data?: {
    error_message?: string;
    status?: string;
  };
  verification_data?: {
    error_message?: string;
    status?: string;
  };
};

export async function ensureAndMarkAppDomains(env: Env, appId: string, statusPatch: DomainStatusPatch): Promise<CloudflareDomainRuntime> {
  return reconcileAndMarkAppDomains(env, appId, statusPatch, false);
}

/**
 * Reconcile the canonical hostname after a release. Pages custom domains need
 * an exact null-script route so the account-wide APPS wildcard does not catch
 * the request before it reaches Pages.
 */
export async function ensurePublishedAppDomain(env: Env, appId: string): Promise<CloudflareDomainRuntime> {
  return reconcileAndMarkAppDomains(env, appId, { production: "active" }, true);
}

async function reconcileAndMarkAppDomains(
  env: Env,
  appId: string,
  statusPatch: DomainStatusPatch,
  published: boolean
): Promise<CloudflareDomainRuntime> {
  try {
    const runtime = await ensureCloudflareAppRuntime(env, appId, published);
    const statements = [
      env.APPS_DB
        .prepare(
          `
          UPDATE apps_domains
          SET provider = ?,
              provider_resource_id = ?,
              dns_record_id = ?,
              route_id = ?,
              certificate_status = ?,
              route_status = ?,
              last_checked_at = ?,
              error_code = NULL,
              error_message = NULL
          WHERE app_id = ?
          `
        )
        .bind(
          runtime.provider,
          runtime.providerResourceId,
          runtime.dnsRecordId,
          runtime.routeId,
          runtime.certificateStatus,
          runtime.routeStatus,
          runtime.checkedAt,
          appId
        )
    ];

    for (const [type, status] of Object.entries(statusPatch)) {
      statements.push(
        env.APPS_DB
          .prepare("UPDATE apps_domains SET status = ? WHERE app_id = ? AND type = ?")
          .bind(status, appId, type)
      );
    }

    await env.APPS_DB.batch(statements);
    return runtime;
  } catch (error) {
    const message = error instanceof Error ? error.message : "cloudflare_domain_provisioning_failed";
    await env.APPS_DB
      .prepare(
        `
        UPDATE apps_domains
        SET route_status = 'failed',
            error_code = 'cloudflare_provisioning_failed',
            error_message = ?,
            last_checked_at = ?
        WHERE app_id = ?
        `
      )
      .bind(message.slice(0, 500), new Date().toISOString(), appId)
      .run();
    throw error;
  }
}

/**
 * Pages custom domains must bypass the platform's catch-all APPS Worker route.
 * A null-script exact route lets the Pages CNAME receive the request.
 */
export async function ensurePagesWorkerRouteBypass(env: Env, hostname: string): Promise<CloudflareWorkerRoute> {
  const zoneId = requireCloudflareZoneId(env);
  const pattern = `${hostname.trim().toLowerCase()}/*`;
  const routes = await cloudflareFetch<CloudflareWorkerRoute[]>(env, `/zones/${zoneId}/workers/routes?per_page=100`);
  const existing = routes.find((route) => route.pattern === pattern);
  if (!existing) {
    return cloudflareFetch<CloudflareWorkerRoute>(env, `/zones/${zoneId}/workers/routes`, {
      body: JSON.stringify({ pattern, script: null }),
      method: "POST"
    });
  }
  if (existing.script) {
    return cloudflareFetch<CloudflareWorkerRoute>(env, `/zones/${zoneId}/workers/routes/${encodeURIComponent(existing.id)}`, {
      body: JSON.stringify({ pattern, script: null }),
      method: "PUT"
    });
  }
  return existing;
}

async function ensureCloudflareAppRuntime(env: Env, appId: string, published = false): Promise<CloudflareDomainRuntime> {
  const [domain, resources] = await Promise.all([
    env.APPS_DB
      .prepare("SELECT * FROM apps_domains WHERE app_id = ? AND type = 'production' LIMIT 1")
      .bind(appId)
      .first<AppsDomainRow>(),
    env.APPS_DB
      .prepare("SELECT * FROM apps_app_resources WHERE app_id = ? AND environment = 'prod' AND status = 'ready' ORDER BY created_at")
      .bind(appId)
      .all<AppsResourceRow>()
  ]);
  const hostname = readString(domain?.hostname).trim().toLowerCase();
  if (!hostname) {
    throw new HttpError(409, "production_domain_not_configured");
  }

  const resourceRows = resources.results ?? [];
  const pages = resourceRows.find((resource) => resource.type === "pages_project");
  if (pages) {
    const runtime = await ensureCloudflarePagesDomain(env, hostname, pages);
    if (!published) {
      return runtime;
    }
    // Complete the Cloudflare mutation before the caller marks the domain
    // active. A bypass failure must leave the database in a failed state.
    const route = await ensurePagesWorkerRouteBypass(env, hostname);
    return { ...runtime, routeId: route.id, routeStatus: "active" };
  }

  const worker = resourceRows.find((resource) => resource.type === "worker");
  if (worker) {
    return ensureCloudflareWorkerDomain(env, hostname, worker);
  }

  throw new HttpError(409, "runtime_resource_not_ready");
}

async function ensureCloudflarePagesDomain(env: Env, hostname: string, pages: AppsResourceRow): Promise<CloudflareDomainRuntime> {
  const accountId = requireCloudflareAccountId(env);
  const projectName = readString(pages.resource_name || pages.resource_id).trim();
  if (!projectName) {
    throw new HttpError(409, "pages_project_resource_not_ready");
  }

  const dns = await ensureCnameRecord(env, hostname, `${projectName}.pages.dev`, "Workspace APPS Pages app domain");
  const existing = await cloudflareOptionalFetch<CloudflarePagesDomain>(
    env,
    `/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/domains/${encodeURIComponent(hostname)}`
  );
  const domain = existing ?? await cloudflareFetch<CloudflarePagesDomain>(
    env,
    `/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/domains`,
    {
      body: JSON.stringify({ name: hostname }),
      method: "POST"
    }
  );

  const status = readString(domain.status).trim() || "pending";
  const certificateStatus =
    readString(domain.verification_data?.status).trim() ||
    readString(domain.validation_data?.status).trim() ||
    status;

  return {
    certificateStatus,
    checkedAt: new Date().toISOString(),
    dnsRecordId: dns.id,
    provider: "cloudflare-pages",
    providerResourceId: readString(domain.id || domain.domain_id || hostname),
    routeId: "",
    routeStatus: status
  };
}

async function ensureCloudflareWorkerDomain(env: Env, hostname: string, worker: AppsResourceRow): Promise<CloudflareDomainRuntime> {
  const scriptName = readString(worker.resource_id || worker.resource_name).trim();
  if (!scriptName) {
    throw new HttpError(409, "worker_resource_not_ready");
  }

  const dns = await ensureAaaaRecord(env, hostname, "100::", "Workspace APPS Worker app domain");
  const route = await ensureWorkerRoute(env, `${hostname}/*`, scriptName);
  return {
    certificateStatus: "proxied",
    checkedAt: new Date().toISOString(),
    dnsRecordId: dns.id,
    provider: "cloudflare-workers",
    providerResourceId: scriptName,
    routeId: route.id,
    routeStatus: "active"
  };
}

async function ensureCnameRecord(env: Env, hostname: string, content: string, comment: string) {
  const zoneId = requireCloudflareZoneId(env);
  const records = await cloudflareFetch<CloudflareDnsRecord[]>(
    env,
    `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}&per_page=10`
  );
  let record = records.find((item) => item.name === hostname && item.type === "CNAME");
  if (!record) {
    record = await cloudflareFetch<CloudflareDnsRecord>(env, `/zones/${zoneId}/dns_records`, {
      body: JSON.stringify({
        comment,
        content,
        name: hostname,
        proxied: true,
        ttl: 1,
        type: "CNAME"
      }),
      method: "POST"
    });
  } else if (record.content !== content || record.proxied !== true) {
    record = await cloudflareFetch<CloudflareDnsRecord>(env, `/zones/${zoneId}/dns_records/${record.id}`, {
      body: JSON.stringify({
        comment,
        content,
        proxied: true,
        ttl: 1
      }),
      method: "PATCH"
    });
  }
  return record;
}

async function ensureAaaaRecord(env: Env, hostname: string, content: string, comment: string) {
  const zoneId = requireCloudflareZoneId(env);
  const records = await cloudflareFetch<CloudflareDnsRecord[]>(
    env,
    `/zones/${zoneId}/dns_records?type=AAAA&name=${encodeURIComponent(hostname)}&per_page=10`
  );
  let record = records.find((item) => item.name === hostname && item.type === "AAAA");
  if (!record) {
    record = await cloudflareFetch<CloudflareDnsRecord>(env, `/zones/${zoneId}/dns_records`, {
      body: JSON.stringify({
        comment,
        content,
        name: hostname,
        proxied: true,
        ttl: 1,
        type: "AAAA"
      }),
      method: "POST"
    });
  } else if (record.content !== content || record.proxied !== true) {
    record = await cloudflareFetch<CloudflareDnsRecord>(env, `/zones/${zoneId}/dns_records/${record.id}`, {
      body: JSON.stringify({
        comment,
        content,
        proxied: true,
        ttl: 1
      }),
      method: "PATCH"
    });
  }
  return record;
}

async function ensureWorkerRoute(env: Env, routePattern: string, scriptName: string) {
  const zoneId = requireCloudflareZoneId(env);
  const routes = await cloudflareFetch<CloudflareWorkerRoute[]>(
    env,
    `/zones/${zoneId}/workers/routes?per_page=100`
  );
  let route = routes.find((item) => item.pattern === routePattern);

  if (!route) {
    route = await cloudflareFetch<CloudflareWorkerRoute>(env, `/zones/${zoneId}/workers/routes`, {
      body: JSON.stringify({ pattern: routePattern, script: scriptName }),
      method: "POST"
    });
  } else if (route.script !== scriptName) {
    route = await cloudflareFetch<CloudflareWorkerRoute>(env, `/zones/${zoneId}/workers/routes/${route.id}`, {
      body: JSON.stringify({ pattern: routePattern, script: scriptName }),
      method: "PUT"
    });
  }

  return route;
}

async function ensureCloudflareWildcardRuntime(env: Env): Promise<CloudflareDomainRuntime> {
  const token = readString(env.CF_API_TOKEN).trim();
  const zoneId = requireCloudflareZoneId(env);

  if (!token) {
    throw new HttpError(503, "cloudflare_provisioning_not_configured");
  }

  const domain = (readString(env.CF_ZONE_NAME).trim() || baseDomain(env)).toLowerCase();
  const dnsName = `*.${domain}`;
  const routePattern = `*.${domain}/*`;
  const scriptName = readString(env.CF_APPS_WORKER_NAME).trim() || "workspace-apps-worker";
  const dnsRecords = await cloudflareFetch<CloudflareDnsRecord[]>(
    env,
    `/zones/${zoneId}/dns_records?type=AAAA&name=${encodeURIComponent(dnsName)}&per_page=10`
  );
  let dns = dnsRecords.find((record) => record.name === dnsName && record.type === "AAAA");

  if (!dns) {
    dns = await cloudflareFetch<CloudflareDnsRecord>(env, `/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify({
        comment: "Workspace APPS app wildcard runtime",
        content: "100::",
        name: "*",
        proxied: true,
        ttl: 1,
        type: "AAAA"
      })
    });
  } else if (dns.content !== "100::" || dns.proxied !== true) {
    dns = await cloudflareFetch<CloudflareDnsRecord>(env, `/zones/${zoneId}/dns_records/${dns.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        comment: "Workspace APPS app wildcard runtime",
        content: "100::",
        proxied: true,
        ttl: 1
      })
    });
  }

  const routes = await cloudflareFetch<CloudflareWorkerRoute[]>(
    env,
    `/zones/${zoneId}/workers/routes?per_page=100`
  );
  let route = routes.find((item) => item.pattern === routePattern);

  if (!route) {
    route = await cloudflareFetch<CloudflareWorkerRoute>(env, `/zones/${zoneId}/workers/routes`, {
      method: "POST",
      body: JSON.stringify({ pattern: routePattern, script: scriptName })
    });
  } else if (route.script !== scriptName) {
    route = await cloudflareFetch<CloudflareWorkerRoute>(env, `/zones/${zoneId}/workers/routes/${route.id}`, {
      method: "PUT",
      body: JSON.stringify({ pattern: routePattern, script: scriptName })
    });
  }

  return {
    certificateStatus: "wildcard_ready",
    checkedAt: new Date().toISOString(),
    dnsRecordId: dns.id,
    provider: "cloudflare",
    providerResourceId: scriptName,
    routeId: route.id,
    routeStatus: "active"
  };
}
