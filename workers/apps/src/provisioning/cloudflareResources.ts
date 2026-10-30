import { cloudflareApiResponse, cloudflareFetch, cloudflareOptionalFetch, requireCloudflareAccountId } from "../cloudflare/client";
import {
  APPS_HYPERDRIVE_PASSWORD_SECRET_NAME,
  APPS_HYPERDRIVE_RESOURCE_TYPE,
  type AppsHyperdriveDeploymentInput,
  type AppsHyperdriveScheme
} from "../../../../src/shared/appsHyperdrive";
import { decryptSecretValue } from "../core/auth";
import { HttpError, type Env } from "../core/types";
import { asRecord, normalizeAppCode, readString } from "../core/utils";
import type { AppsAppRow, AppsAppSecretRow, AppsResourceRow } from "../db/rows";
import { provisionAppStream } from "../apps/streamService";

type ProvisionedResource = {
  name: string;
  provider: string;
  resourceId: string;
};

type CloudflareD1Database = {
  name?: string;
  uuid?: string;
};

type CloudflareKvNamespace = {
  id?: string;
  title?: string;
};

type CloudflareR2Bucket = {
  name?: string;
};

type CloudflareQueue = {
  queue_id?: string;
  queue_name?: string;
};

type CloudflareHyperdrive = {
  id?: string;
  name?: string;
};

type CloudflarePagesProject = {
  id?: string;
  name?: string;
  subdomain?: string;
};

const CLOUDFLARE_RESOURCE_TYPES = new Set([
  "d1_database",
  "kv_namespace",
  "r2_bucket",
  "queue",
  "pages_project",
  "pages_function",
  "worker"
]);

export async function provisionResourceTypes(
  env: Env,
  app: AppsAppRow,
  resourceTypes: string[],
  now: string,
  options: { requireRegistered?: boolean } = {}
) {
  if (resourceTypes.length === 0) {
    return;
  }

  const rows = await env.APPS_DB
    .prepare(
      `
      SELECT *
      FROM apps_app_resources
      WHERE app_id = ?
        AND type IN (${resourceTypes.map(() => "?").join(", ")})
      ORDER BY created_at
      `
    )
    .bind(app.id, ...resourceTypes)
    .all<AppsResourceRow>();

  if (options.requireRegistered) {
    const registeredTypes = new Set((rows.results ?? []).map((resource) => resource.type));
    const missingTypes = resourceTypes.filter((resourceType) => !registeredTypes.has(resourceType));
    if (missingTypes.length > 0) {
      throw new HttpError(409, "provisioning_resource_registry_missing", { missingTypes });
    }
  }

  if (!rows.results?.length) return;

  for (const resource of rows.results ?? []) {
    if (resource.status === "placeholder") {
      continue;
    }
    const provisioned = resource.type === "media"
      ? await provisionAppStream(env, app)
      : CLOUDFLARE_RESOURCE_TYPES.has(resource.type)
      ? await ensureCloudflareResource(env, app, resource)
      : logicalResource(resource);

    await env.APPS_DB
      .prepare(
        `
        UPDATE apps_app_resources
        SET provider = ?,
            resource_name = ?,
            resource_id = ?,
            binding_name = CASE WHEN type = 'media' THEN 'WORKSPACE_STREAM' ELSE binding_name END,
            status = 'ready'
        WHERE id = ?
        `
      )
      .bind(provisioned.provider, provisioned.name, provisioned.resourceId, resource.id)
      .run();
  }

  await env.APPS_DB
    .prepare("UPDATE apps_apps SET updated_at = ? WHERE id = ?")
    .bind(now, app.id)
    .run();
}

export async function configureHyperdriveForDeployment(
  env: Env,
  app: AppsAppRow,
  value: unknown,
  now = new Date().toISOString()
) {
  const resource = await env.APPS_DB
    .prepare("SELECT * FROM apps_app_resources WHERE app_id = ? AND type = ? AND environment = 'prod' LIMIT 1")
    .bind(app.id, APPS_HYPERDRIVE_RESOURCE_TYPE)
    .first<AppsResourceRow>();

  if (!resource) {
    if (value !== undefined) {
      throw new HttpError(409, "hyperdrive_resource_not_enabled", {
        how: "Add hyperdrive_config to the App before supplying custom database deployment parameters."
      });
    }
    return undefined;
  }

  const existingResourceId = readString(resource.resource_id).trim();
  if (resource.status === "ready" && existingResourceId) {
    return {
      bindingName: readString(resource.binding_name).trim() || "HYPERDRIVE",
      resourceId: existingResourceId,
      resourceName: resource.resource_name
    };
  }

  const input = normalizeHyperdriveDeploymentInput(value);
  const passwordSecret = await env.APPS_DB
    .prepare("SELECT * FROM apps_app_secrets WHERE app_id = ? AND environment = 'production' AND name = ? LIMIT 1")
    .bind(app.id, APPS_HYPERDRIVE_PASSWORD_SECRET_NAME)
    .first<AppsAppSecretRow>();
  if (!passwordSecret || passwordSecret.status !== "configured" || !passwordSecret.cipher_text || !passwordSecret.cipher_iv) {
    throw new HttpError(409, "hyperdrive_password_secret_not_configured", {
      secretName: APPS_HYPERDRIVE_PASSWORD_SECRET_NAME,
      how: "Configure this App Secret in APPS, then retry the MCP deployment. Never pass the database password in MCP arguments or source files."
    });
  }
  const password = await decryptSecretValue(env, {
    algorithm: passwordSecret.algorithm,
    cipherIv: passwordSecret.cipher_iv,
    cipherText: passwordSecret.cipher_text
  });

  const accountId = requireCloudflareAccountId(env);
  const name = cloudflareResourceName(resource.resource_name, 63);
  const listed = await cloudflareFetch<unknown>(env, `/accounts/${accountId}/hyperdrive/configs`);
  const existing = collection<CloudflareHyperdrive>(listed, ["configs"])
    .find((config) => readString(config.name).trim() === name);
  const hyperdrive = existing ?? await cloudflareFetch<CloudflareHyperdrive>(env, `/accounts/${accountId}/hyperdrive/configs`, {
    body: JSON.stringify({
      name,
      origin: {
        database: input.database,
        host: input.host,
        password,
        ...(input.port ? { port: input.port } : {}),
        scheme: input.scheme,
        user: input.user
      },
      ...(input.originConnectionLimit ? { origin_connection_limit: input.originConnectionLimit } : {})
    }),
    method: "POST"
  });
  const resourceId = readString(hyperdrive.id).trim();
  if (!resourceId) {
    throw new HttpError(502, "cloudflare_hyperdrive_id_missing");
  }

  await env.APPS_DB
    .prepare("UPDATE apps_app_resources SET provider = 'cloudflare-hyperdrive', resource_name = ?, resource_id = ?, binding_name = 'HYPERDRIVE', status = 'ready' WHERE id = ?")
    .bind(name, resourceId, resource.id)
    .run();
  await env.APPS_DB.prepare("UPDATE apps_apps SET updated_at = ? WHERE id = ?").bind(now, app.id).run();

  return { bindingName: "HYPERDRIVE", resourceId, resourceName: name };
}

function normalizeHyperdriveDeploymentInput(value: unknown): AppsHyperdriveDeploymentInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(409, "hyperdrive_configuration_required", {
      requiredDeploymentInput: ["scheme", "host", "database", "user"],
      passwordSecretName: APPS_HYPERDRIVE_PASSWORD_SECRET_NAME
    });
  }
  const record = asRecord(value);
  const scheme = readString(record.scheme).trim().toLowerCase() as AppsHyperdriveScheme;
  if (scheme !== "postgres" && scheme !== "postgresql" && scheme !== "mysql") {
    throw new HttpError(400, "invalid_hyperdrive_scheme");
  }
  const host = requiredHyperdriveText(record.host, "invalid_hyperdrive_host", 253);
  if (/\s|[:/]\/|\/|@/.test(host)) {
    throw new HttpError(400, "invalid_hyperdrive_host");
  }
  const database = requiredHyperdriveText(record.database, "invalid_hyperdrive_database", 128);
  const user = requiredHyperdriveText(record.user, "invalid_hyperdrive_user", 128);
  const port = optionalInteger(record.port, "invalid_hyperdrive_port", 1, 65_535);
  const originConnectionLimit = optionalInteger(record.originConnectionLimit, "invalid_hyperdrive_origin_connection_limit", 5, 100);
  return { database, host, originConnectionLimit, port, scheme, user };
}

function requiredHyperdriveText(value: unknown, code: string, maxLength: number) {
  const text = readString(value).trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new HttpError(400, code);
  }
  return text;
}

function optionalInteger(value: unknown, code: string, minimum: number, maximum: number) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new HttpError(400, code);
  }
  return number;
}

async function ensureCloudflareResource(env: Env, app: AppsAppRow, resource: AppsResourceRow): Promise<ProvisionedResource> {
  if (resource.type === "d1_database") {
    if (resource.provider !== "cloudflare" && resource.provider !== "cloudflare-d1") {
      throw new HttpError(409, "d1_database_resource_provider_invalid");
    }
    return ensureD1Database(env, resource.resource_name);
  }
  if (resource.type === "kv_namespace") {
    return ensureKvNamespace(env, resource.resource_name);
  }
  if (resource.type === "r2_bucket") {
    return ensureR2Bucket(env, resource.resource_name);
  }
  if (resource.type === "queue") {
    return ensureQueue(env, resource.resource_name);
  }
  if (resource.type === "pages_project" || resource.type === "pages_function") {
    const pagesName = pagesProjectName(app, resource);
    return ensurePagesProject(env, pagesName);
  }
  if (resource.type === "worker") {
    // A ready Worker resource already has a platform-owned script name. Do not
    // reconcile it through the legacy script PUT endpoint during every deploy:
    // Cloudflare rejects that endpoint when a Queue consumer is attached
    // unless the uploaded module includes the queue handler. The deployment
    // path uploads the complete module through the Version API, which is the
    // only safe place to validate the final fetch/queue/scheduled handlers.
    if (resource.status === "ready" && readString(resource.resource_id).trim()) {
      return logicalResource(resource);
    }
    return ensureWorkerScript(env, resource.resource_name);
  }
  return logicalResource(resource);
}

async function ensureD1Database(env: Env, requestedName: string): Promise<ProvisionedResource> {
  const accountId = requireCloudflareAccountId(env);
  const name = cloudflareResourceName(requestedName, 63);
  const listed = await cloudflareFetch<unknown>(env, `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=100`);
  const existing = collection<CloudflareD1Database>(listed, ["databases"]).find((item) => item.name === name);
  const database = existing ?? await cloudflareFetch<CloudflareD1Database>(env, `/accounts/${accountId}/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name })
  });

  return {
    name,
    provider: "cloudflare-d1",
    resourceId: readString(database.uuid || database.name || name)
  };
}

async function ensureKvNamespace(env: Env, requestedName: string): Promise<ProvisionedResource> {
  const accountId = requireCloudflareAccountId(env);
  const title = cloudflareResourceName(requestedName, 128);
  const listed = await cloudflareFetch<unknown>(env, `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const existing = collection<CloudflareKvNamespace>(listed, ["namespaces"]).find((item) => item.title === title);
  const namespace = existing ?? await cloudflareFetch<CloudflareKvNamespace>(env, `/accounts/${accountId}/storage/kv/namespaces`, {
    method: "POST",
    body: JSON.stringify({ title })
  });

  return {
    name: title,
    provider: "cloudflare-kv",
    resourceId: readString(namespace.id || namespace.title || title)
  };
}

async function ensureR2Bucket(env: Env, requestedName: string): Promise<ProvisionedResource> {
  const accountId = requireCloudflareAccountId(env);
  const name = cloudflareResourceName(requestedName, 63);
  const existing = await cloudflareOptionalFetch<CloudflareR2Bucket>(env, `/accounts/${accountId}/r2/buckets/${encodeURIComponent(name)}`);
  const bucket = existing ?? await cloudflareFetch<CloudflareR2Bucket>(env, `/accounts/${accountId}/r2/buckets`, {
    method: "POST",
    body: JSON.stringify({ name })
  });

  return {
    name,
    provider: "cloudflare-r2",
    resourceId: readString(bucket.name || name)
  };
}

async function ensureQueue(env: Env, requestedName: string): Promise<ProvisionedResource> {
  const accountId = requireCloudflareAccountId(env);
  const name = cloudflareResourceName(requestedName, 63);
  const existing = await findQueueByName(env, accountId, name);
  const queue = existing ?? await cloudflareFetch<CloudflareQueue>(env, `/accounts/${accountId}/queues`, {
    method: "POST",
    body: JSON.stringify({ queue_name: name })
  });
  const resourceId = readString(queue.queue_id).trim();
  if (!resourceId) {
    throw new HttpError(502, "cloudflare_queue_id_missing");
  }

  return {
    name,
    provider: "cloudflare-queues",
    resourceId
  };
}

async function findQueueByName(env: Env, accountId: string, name: string) {
  for (let page = 1; page <= 10; page += 1) {
    const response = await cloudflareApiResponse(env, `/accounts/${accountId}/queues?page=${page}&per_page=1000`);
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const existing = collection<CloudflareQueue>(payload.result, ["queues"])
      .find((queue) => queue.queue_name === name);
    if (existing) {
      return existing;
    }
    const resultInfo = asRecord(payload.result_info);
    const totalPages = Number(resultInfo.total_pages || 1);
    if (!Number.isFinite(totalPages) || page >= totalPages) {
      return undefined;
    }
  }
  throw new HttpError(502, "cloudflare_queue_list_incomplete");
}

async function ensurePagesProject(env: Env, requestedName: string): Promise<ProvisionedResource> {
  const accountId = requireCloudflareAccountId(env);
  const name = cloudflareResourceName(requestedName, 58);
  const existing = await cloudflareOptionalFetch<CloudflarePagesProject>(env, `/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}`);
  const project = existing ?? await cloudflareFetch<CloudflarePagesProject>(env, `/accounts/${accountId}/pages/projects`, {
    method: "POST",
    body: JSON.stringify({
      name,
      production_branch: "main"
    })
  });

  return {
    name,
    provider: "cloudflare-pages",
    resourceId: readString(project.id || project.name || name)
  };
}

async function ensureWorkerScript(env: Env, requestedName: string): Promise<ProvisionedResource> {
  const accountId = requireCloudflareAccountId(env);
  const name = cloudflareResourceName(requestedName, 63);
  const existing = await cloudflareOptionalFetch<Record<string, unknown>>(env, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}`);
  if (!existing) {
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({
      bindings: [],
      compatibility_date: "2026-06-16",
      main_module: "index.js"
    })], { type: "application/json" }), "metadata.json");
    form.append("index.js", new Blob([placeholderWorkerSource(name)], { type: "application/javascript+module" }), "index.js");
    await cloudflareFetch<Record<string, unknown>>(env, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}`, {
      body: form,
      method: "PUT"
    });
  }

  return {
    name,
    provider: "cloudflare-workers",
    resourceId: name
  };
}

function logicalResource(resource: AppsResourceRow): ProvisionedResource {
  return {
    name: resource.resource_name,
    provider: resource.provider,
    resourceId: readString(resource.resource_id || resource.resource_name)
  };
}

function pagesProjectName(app: AppsAppRow, resource: AppsResourceRow) {
  if (resource.type === "pages_project") {
    return resource.resource_name;
  }
  return `apps-${normalizeAppCode(app.code || app.slug || app.id)}-pages`;
}

function cloudflareResourceName(value: string, maxLength: number) {
  const normalized = normalizeAppCode(value) || "apps-app";
  return normalized
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, "") || "apps-app";
}

function collection<T>(value: unknown, arrayKeys: string[]): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  const record = asRecord(value);
  for (const key of arrayKeys) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      return nested as T[];
    }
  }
  const result = record.result;
  if (Array.isArray(result)) {
    return result as T[];
  }
  return [];
}

function placeholderWorkerSource(name: string) {
  return [
    "export default {",
    "  async fetch() {",
    `    return new Response("Workspace APPS worker resource ${name} is provisioned. Deploy source through APPS MCP.", { status: 503 });`,
    "  }",
    "};"
  ].join("\n");
}
