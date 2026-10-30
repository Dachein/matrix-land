import { cloudflareApiResponse, requireCloudflareAccountId, requireCloudflareZoneId } from "../cloudflare/client";
import { HttpError, type Env } from "../core/types";
import { asRecord, normalizeAppCode, readString } from "../core/utils";
import type { AppsAppRow, AppsDomainRow, AppsResourceRow } from "../db/rows";

export type AppResourceCleanupResult = {
  deletedExternalResources: string[];
};

export async function deleteAppExternalResources(
  env: Env,
  app: AppsAppRow,
  resources: AppsResourceRow[],
  domains: AppsDomainRow[]
): Promise<AppResourceCleanupResult> {
  const deletedExternalResources: string[] = [];

  await deleteDomainResources(env, app, resources, domains, deletedExternalResources);
  await deleteProvisionedResources(env, app, resources, deletedExternalResources);

  return { deletedExternalResources };
}

async function deleteDomainResources(
  env: Env,
  app: AppsAppRow,
  resources: AppsResourceRow[],
  domains: AppsDomainRow[],
  deletedExternalResources: string[]
) {
  const pagesProject = resources.find((resource) => resource.type === "pages_project" || resource.type === "pages_function");
  const pagesProjectName = pagesProject ? pagesResourceName(app, pagesProject) : "";

  for (const domain of domains) {
    const hostname = readString(domain.hostname).trim().toLowerCase();
    if (domain.provider === "cloudflare-pages" && hostname && pagesProjectName) {
      const accountId = requireCloudflareAccountId(env);
      await deleteCloudflareOptional(
        env,
        `/accounts/${accountId}/pages/projects/${encodeURIComponent(pagesProjectName)}/domains/${encodeURIComponent(hostname)}`,
        `pages-domain:${hostname}`,
        deletedExternalResources
      );
    }

    const routeId = readString(domain.route_id).trim();
    if (routeId) {
      const zoneId = requireCloudflareZoneId(env);
      await deleteCloudflareOptional(
        env,
        `/zones/${zoneId}/workers/routes/${encodeURIComponent(routeId)}`,
        `worker-route:${routeId}`,
        deletedExternalResources
      );
    }

    const dnsRecordId = readString(domain.dns_record_id).trim();
    if (dnsRecordId) {
      const zoneId = requireCloudflareZoneId(env);
      await deleteCloudflareOptional(
        env,
        `/zones/${zoneId}/dns_records/${encodeURIComponent(dnsRecordId)}`,
        `dns-record:${dnsRecordId}`,
        deletedExternalResources
      );
    }
  }
}

async function deleteProvisionedResources(
  env: Env,
  app: AppsAppRow,
  resources: AppsResourceRow[],
  deletedExternalResources: string[]
) {
  const deletedPagesProjects = new Set<string>();

  for (const resource of [...resources].sort((left, right) => deletionPriority(left) - deletionPriority(right))) {
    if (!shouldDeleteExternalResource(resource)) {
      continue;
    }

    if (resource.type === "d1_database" && resource.provider === "cloudflare-d1") {
      const resourceId = readString(resource.resource_id).trim();
      if (resourceId) {
        const accountId = requireCloudflareAccountId(env);
        await deleteCloudflareOptional(
          env,
          `/accounts/${accountId}/d1/database/${encodeURIComponent(resourceId)}`,
          `d1:${resourceId}`,
          deletedExternalResources
        );
      }
      continue;
    }

    if (resource.type === "kv_namespace" && resource.provider === "cloudflare-kv") {
      const resourceId = readString(resource.resource_id).trim();
      if (resourceId) {
        const accountId = requireCloudflareAccountId(env);
        await deleteCloudflareOptional(
          env,
          `/accounts/${accountId}/storage/kv/namespaces/${encodeURIComponent(resourceId)}`,
          `kv:${resourceId}`,
          deletedExternalResources
        );
      }
      continue;
    }

    if (resource.type === "r2_bucket" && resource.provider === "cloudflare-r2") {
      const bucketName = readString(resource.resource_id || resource.resource_name).trim();
      if (bucketName) {
        const accountId = requireCloudflareAccountId(env);
        const deletedObjectCount = await deleteR2BucketObjects(env, accountId, bucketName);
        if (deletedObjectCount > 0) {
          deletedExternalResources.push(`r2-objects:${bucketName}:${deletedObjectCount}`);
        }
        await deleteCloudflareOptional(
          env,
          `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}`,
          `r2:${bucketName}`,
          deletedExternalResources
        );
      }
      continue;
    }

    if (resource.type === "queue" && resource.provider === "cloudflare-queues") {
      const resourceId = readString(resource.resource_id).trim();
      if (resourceId) {
        const accountId = requireCloudflareAccountId(env);
        await deleteCloudflareOptional(
          env,
          `/accounts/${accountId}/queues/${encodeURIComponent(resourceId)}`,
          `queue:${resourceId}`,
          deletedExternalResources
        );
      }
      continue;
    }

    if (resource.type === "hyperdrive_config" && resource.provider === "cloudflare-hyperdrive") {
      const resourceId = readString(resource.resource_id).trim();
      if (resourceId) {
        const accountId = requireCloudflareAccountId(env);
        await deleteCloudflareOptional(
          env,
          `/accounts/${accountId}/hyperdrive/configs/${encodeURIComponent(resourceId)}`,
          `hyperdrive:${resourceId}`,
          deletedExternalResources
        );
      }
      continue;
    }

    if ((resource.type === "pages_project" || resource.type === "pages_function") && resource.provider === "cloudflare-pages") {
      const projectName = pagesResourceName(app, resource);
      if (projectName && !deletedPagesProjects.has(projectName)) {
        const accountId = requireCloudflareAccountId(env);
        deletedPagesProjects.add(projectName);
        await deleteCloudflareOptional(
          env,
          `/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`,
          `pages:${projectName}`,
          deletedExternalResources
        );
      }
      continue;
    }

    if (resource.type === "worker" && resource.provider === "cloudflare-workers") {
      const scriptName = readString(resource.resource_id || resource.resource_name).trim();
      if (scriptName) {
        const accountId = requireCloudflareAccountId(env);
        await deleteCloudflareOptional(
          env,
          `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`,
          `worker:${scriptName}`,
          deletedExternalResources
        );
      }
    }
  }
}

function deletionPriority(resource: AppsResourceRow) {
  if (resource.type === "worker" || resource.type === "pages_project" || resource.type === "pages_function") {
    return 0;
  }
  if (resource.type === "queue") {
    return 1;
  }
  return 2;
}

function shouldDeleteExternalResource(resource: AppsResourceRow) {
  return resource.provider.startsWith("cloudflare-")
    && (resource.status === "ready" || Boolean(readString(resource.resource_id).trim()));
}

function pagesResourceName(app: AppsAppRow, resource: AppsResourceRow) {
  if (resource.type === "pages_project") {
    return readString(resource.resource_name || resource.resource_id).trim();
  }
  const appCode = normalizeAppCode(app.code || app.slug || app.id);
  return appCode ? `apps-${appCode}-pages` : readString(resource.resource_name || resource.resource_id).trim();
}

async function deleteCloudflareOptional(env: Env, path: string, label: string, deletedExternalResources: string[]) {
  const response = await cloudflareApiResponse(env, path, { method: "DELETE" }, { allowNotFound: true });
  if (response.status !== 404) {
    deletedExternalResources.push(label);
  }
}

async function deleteR2BucketObjects(env: Env, accountId: string, bucketName: string) {
  let deletedCount = 0;
  let cursor = "";
  const seenCursors = new Set<string>();

  while (true) {
    const params = new URLSearchParams({ per_page: "1000" });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const response = await cloudflareApiResponse(
      env,
      `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects?${params}`,
      {},
      { allowNotFound: true }
    );
    if (response.status === 404) {
      return deletedCount;
    }

    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const objects = collection(payload.result ?? payload, ["objects"]);
    const resultInfo = asRecord(payload.result_info);

    for (const object of objects) {
      const key = readString(asRecord(object).key || asRecord(object).name).trim();
      if (!key) {
        continue;
      }
      const deleteResponse = await cloudflareApiResponse(
        env,
        `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeStoragePath(key)}`,
        { method: "DELETE" },
        { allowNotFound: true }
      );
      if (deleteResponse.status !== 404) {
        deletedCount += 1;
      }
    }

    const truncated = resultInfo.is_truncated === true || resultInfo.truncated === true;
    const nextCursor = readString(resultInfo.cursor || resultInfo.cursor_next || resultInfo.cursorNext).trim();
    if (!truncated && !nextCursor) {
      return deletedCount;
    }
    if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) {
      throw new HttpError(502, "r2_cleanup_pagination_invalid");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

function collection(value: unknown, arrayKeys: string[]) {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  for (const key of arrayKeys) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      return nested;
    }
  }
  return [];
}

function encodeStoragePath(key: string) {
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
}
