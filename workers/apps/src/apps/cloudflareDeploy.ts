import { blake3 } from "@noble/hashes/blake3.js";
import { APPS_HYPERDRIVE_PASSWORD_SECRET_NAME } from "../../../../src/shared/appsHyperdrive";
import { cloudflareFetch, requireCloudflareAccountId } from "../cloudflare/client";
import { decryptSecretValue } from "../core/auth";
import { HttpError, type Env } from "../core/types";
import { asRecord, normalizeAppCode, readString } from "../core/utils";
import { provisionResourceTypes } from "../provisioning/cloudflareResources";
import type { AppsAppRow, AppsAppSecretRow, AppsResourceRow } from "../db/rows";
import { authIssuer, fallbackRuntimeUrls } from "../runtime/urls";
import type { DeployArtifactWorkerAssets } from "./deployArtifacts";
import { WORKSPACE_STREAM_BINDING, workspaceStreamWorkerName } from "./streamService";
import { configuredWorkerName } from "../../../../src/shared/requiredConfiguration";

export type CloudflareSourceFile = {
  content: string;
  contentType: string;
  encoding?: "base64" | "text";
  path: string;
};

type CloudflareDeployInput = {
  app: AppsAppRow;
  assets?: DeployArtifactWorkerAssets;
  entrypoint: string;
  files: CloudflareSourceFile[];
  runtimeTopology?: WorkerRuntimeTopology;
  version: string;
};

export type WorkerQueueConsumer = {
  bindingName: string;
  maxBatchSize: number;
  maxBatchTimeout: number;
  maxConcurrency?: number;
  maxRetries: number;
  retryDelay?: number;
};

export type WorkerRuntimeTopology = {
  cronSchedules?: string[];
  queueConsumer?: WorkerQueueConsumer;
};

type EnvVarRow = {
  name: string;
  target: string;
  value: string;
};

type RuntimeBinding = {
  bindingName: string;
  resourceId: string;
  resourceName: string;
  type: string;
};

type RuntimeProjection = {
  bindings: RuntimeBinding[];
  envVars: Array<{ name: string; value: string }>;
  secrets: Array<{ name: string; value: string }>;
};

const CLOUDFLARE_COMPATIBILITY_DATE = "2026-06-16";
const WORKSPACE_APP_MCP_MANIFEST_PATH = ".well-known/workspace-mcp-manifest.json";
export const CLOUDFLARE_WORKER_UPLOAD_MODE = "versions-post-v1";

export async function deployPagesSourceToCloudflare(input: CloudflareDeployInput, env: Env) {
  const accountId = requireCloudflareAccountId(env);
  await provisionResourceTypes(env, input.app, ["pages_project", "pages_function"], new Date().toISOString());
  const pagesProject = await requireReadyAppResource(env, input.app.id, "pages_project");
  const projectName = readString(pagesProject.resource_name || pagesProject.resource_id).trim();
  if (!projectName) {
    throw new HttpError(409, "pages_project_resource_not_ready");
  }

  const projection = await runtimeProjection(env, input.app, "pages");
  await syncPagesProjectConfig(env, input.app, projectName, projection);
  const { assetFiles, deploymentFiles } = splitPagesDeploymentFiles(input.files);
  const manifest = await uploadPagesAssets(env, accountId, projectName, assetFiles);
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  form.append("branch", "main");
  form.append("commit_message", `Workspace APPS deploy ${input.app.code || input.app.slug || input.app.id}@${input.version}`);
  for (const file of deploymentFiles) {
    // Pages Direct Upload requires a nested Workers multipart envelope for
    // `_worker.bundle`; keep the stored artifact readable and wrap it only at
    // the Cloudflare boundary.
    if (file.path === "_worker.bundle") {
      const bundle = await cloudflareWorkerBundle(file, projection.secrets);
      form.append(file.path, new File([bundle], file.path, { type: bundle.type }));
    } else {
      form.append(file.path, new File([sourceFileBytes(file)], file.path, { type: file.contentType }));
    }
  }

  const deployment = await cloudflareFetch<Record<string, unknown>>(
    env,
    `/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/deployments`,
    {
      body: form,
      method: "POST"
    }
  );

  return {
    artifactKey: `cloudflare://pages/${projectName}/${readString(deployment.id) || input.version}`,
    cloudflareDeploymentId: readString(deployment.id),
    url: readString(deployment.url)
  };
}

async function cloudflareWorkerBundle(file: CloudflareSourceFile, secrets: Array<{ name: string; value: string }> = []) {
  const bytes = sourceFileBytes(file);
  const prefix = new TextDecoder().decode(bytes.slice(0, 96));
  const header = new TextDecoder().decode(bytes.slice(0, 2048));
  if (/^--[-\w]+\r?\n/.test(prefix) && /name=["']metadata["']/.test(header)) {
    return new Blob([bytes], { type: "multipart/form-data" });
  }
  const workerForm = new FormData();
  workerForm.set("metadata", JSON.stringify({
    main_module: "worker.js",
    bindings: secrets.map((secret) => ({ name: secret.name, text: secret.value, type: "secret_text" })),
    compatibility_date: CLOUDFLARE_COMPATIBILITY_DATE
  }));
  workerForm.set("worker.js", new File([bytes], "worker.js", { type: "application/javascript+module" }));
  return new Response(workerForm).blob();
}

export async function deployWorkerSourceToCloudflare(input: CloudflareDeployInput, env: Env) {
  const accountId = requireCloudflareAccountId(env);
  if (!/\.(?:m?js|ts)$/.test(input.entrypoint)) {
    throw new HttpError(400, "invalid_worker_entrypoint");
  }

  await provisionResourceTypes(env, input.app, ["worker"], new Date().toISOString());
  const worker = await requireReadyAppResource(env, input.app.id, "worker");
  const scriptName = readString(worker.resource_id || worker.resource_name).trim();
  if (!scriptName) {
    throw new HttpError(409, "worker_resource_not_ready");
  }

  const projection = await runtimeProjection(env, input.app, "worker");
  await validateWorkerRuntimeTopology(env, input.app, projection, input.runtimeTopology);
  const workerFiles = input.files.filter((file) => (
    (!input.assets || !file.path.startsWith(`${input.assets.directory}/`))
    && file.path !== WORKSPACE_APP_MCP_MANIFEST_PATH
  ));
  const assetFiles = input.assets
    ? input.files.filter((file) => file.path.startsWith(`${input.assets!.directory}/`))
    : [];
  const assetsJwt = input.assets
    ? await uploadWorkerAssets(env, accountId, scriptName, input.assets, assetFiles)
    : undefined;
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({
    bindings: workerMetadataBindings(env, projection, input.app, input.assets?.binding),
    compatibility_date: CLOUDFLARE_COMPATIBILITY_DATE,
    ...(projection.bindings.some((binding) => binding.type === "hyperdrive_config")
      ? { compatibility_flags: ["nodejs_compat"] }
      : {}),
    main_module: input.entrypoint,
    ...(input.assets && assetsJwt ? {
      assets: {
        jwt: assetsJwt,
        config: {
          html_handling: input.assets.htmlHandling,
          not_found_handling: input.assets.notFoundHandling,
          run_worker_first: input.assets.runWorkerFirst
        }
      }
    } : {})
  })], { type: "application/json" }), "metadata.json");

  for (const file of workerFiles) {
    form.append(file.path, new Blob([sourceFileBytes(file)], { type: workerModuleContentType(file) }), file.path);
  }

  const deployment = await cloudflareFetch<Record<string, unknown>>(
    env,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/versions`,
    {
      body: form,
      method: "POST"
    }
  );
  const versionId = readString(deployment.id).trim() || await latestWorkerVersionId(env, accountId, scriptName);

  return {
    artifactKey: `cloudflare://workers/${scriptName}/${versionId || input.version}`,
    cloudflareDeploymentId: versionId || scriptName,
    url: ""
  };
}

export async function syncCloudflareDeploymentTopology(
  env: Env,
  app: AppsAppRow,
  artifactKey: string,
  topology?: WorkerRuntimeTopology
) {
  if (!topology) return;
  const target = parseCloudflareArtifactKey(artifactKey);
  if (!target || target.kind !== "workers") {
    throw new HttpError(409, "deployment_cloudflare_worker_target_missing");
  }
  const accountId = requireCloudflareAccountId(env);
  const projection = await runtimeProjection(env, app, "worker");
  await validateWorkerRuntimeTopology(env, app, projection, topology);
  await syncWorkerRuntimeTopology(env, app, accountId, target.resourceName, projection, topology);
}

async function validateWorkerRuntimeTopology(
  env: Env,
  app: AppsAppRow,
  projection: RuntimeProjection,
  topology?: WorkerRuntimeTopology
) {
  if (!topology) return;
  if (topology.cronSchedules) {
    const cron = await env.APPS_DB
      .prepare("SELECT id FROM apps_app_resources WHERE app_id = ? AND environment = 'prod' AND type = 'cron_trigger' LIMIT 1")
      .bind(app.id)
      .first<{ id: string }>();
    if (!cron) {
      throw new HttpError(409, "cron_trigger_resource_not_enabled");
    }
  }
  if (topology.queueConsumer && !projection.bindings.some((binding) => (
    binding.type === "queue" && binding.bindingName === topology.queueConsumer?.bindingName
  ))) {
    throw new HttpError(409, "queue_consumer_binding_not_ready", {
      bindingName: topology.queueConsumer.bindingName
    });
  }
}

async function syncWorkerRuntimeTopology(
  env: Env,
  app: AppsAppRow,
  accountId: string,
  scriptName: string,
  projection: RuntimeProjection,
  topology?: WorkerRuntimeTopology
) {
  if (!topology) return;
  if (topology.cronSchedules) {
    const schedulesPath = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`;
    await cloudflareFetch<Record<string, unknown>>(
      env,
      schedulesPath,
      {
        body: JSON.stringify(topology.cronSchedules.map((cron) => ({ cron }))),
        method: "PUT"
      }
    );
    const verifiedSchedules = cloudflareCronSchedules(await cloudflareFetch<unknown>(env, schedulesPath));
    if (
      verifiedSchedules.length !== topology.cronSchedules.length
      || topology.cronSchedules.some((cron) => !verifiedSchedules.includes(cron))
    ) {
      throw new HttpError(502, "cloudflare_cron_schedule_sync_failed");
    }
    await env.APPS_DB
      .prepare(
        "UPDATE apps_app_resources SET provider = 'cloudflare-workers', resource_id = ?, status = 'ready' WHERE app_id = ? AND environment = 'prod' AND type = 'cron_trigger'"
      )
      .bind(scriptName, app.id)
      .run();
  }
  if (topology.queueConsumer) {
    const queue = projection.bindings.find((binding) => (
      binding.type === "queue" && binding.bindingName === topology.queueConsumer?.bindingName
    ));
    if (!queue) {
      throw new HttpError(409, "queue_consumer_binding_not_ready", {
        bindingName: topology.queueConsumer.bindingName
      });
    }
    await syncWorkerQueueConsumer(env, accountId, scriptName, queue, topology.queueConsumer);
  }
}

type CloudflareQueueConsumer = {
  consumer_id?: string;
  script?: string;
  script_name?: string;
  service?: string;
  type?: string;
};

async function syncWorkerQueueConsumer(
  env: Env,
  accountId: string,
  scriptName: string,
  queue: RuntimeBinding,
  consumer: WorkerQueueConsumer
) {
  const path = `/accounts/${accountId}/queues/${encodeURIComponent(queue.resourceId)}/consumers`;
  const listed = await cloudflareFetch<unknown>(env, path);
  const existing = cloudflareQueueConsumers(listed).find((item) => (
    item.type === "worker"
    && (item.script_name === scriptName || item.script === scriptName || item.service === scriptName)
  ));
  const body = {
    script_name: scriptName,
    settings: {
      batch_size: consumer.maxBatchSize,
      max_retries: consumer.maxRetries,
      max_wait_time_ms: consumer.maxBatchTimeout * 1_000,
      ...(consumer.maxConcurrency === undefined ? {} : { max_concurrency: consumer.maxConcurrency }),
      ...(consumer.retryDelay === undefined ? {} : { retry_delay: consumer.retryDelay })
    },
    type: "worker"
  };
  const consumerId = readString(existing?.consumer_id).trim();
  await cloudflareFetch<Record<string, unknown>>(
    env,
    consumerId ? `${path}/${encodeURIComponent(consumerId)}` : path,
    {
      body: JSON.stringify(body),
      method: consumerId ? "PUT" : "POST"
    }
  );
  const verified = cloudflareQueueConsumers(await cloudflareFetch<unknown>(env, path)).find((item) => (
    item.type === "worker"
    && (item.script_name === scriptName || item.script === scriptName || item.service === scriptName)
  ));
  if (!verified) {
    throw new HttpError(502, "cloudflare_queue_consumer_sync_failed");
  }
}

function cloudflareQueueConsumers(value: unknown): CloudflareQueueConsumer[] {
  if (Array.isArray(value)) return value.map((item) => asRecord(item) as CloudflareQueueConsumer);
  const record = asRecord(value);
  const nested = record.consumers;
  return Array.isArray(nested) ? nested.map((item) => asRecord(item) as CloudflareQueueConsumer) : [];
}

function cloudflareCronSchedules(value: unknown) {
  const items = Array.isArray(value) ? value : asRecord(value).schedules;
  if (!Array.isArray(items)) return [];
  return items.map((item) => readString(asRecord(item).cron).trim()).filter(Boolean);
}

export async function syncReadyAppEmailRuntimeConfig(env: Env, app: AppsAppRow) {
  return syncReadyAppRuntimeConfig(env, app, "mail");
}

export async function syncReadyAppStreamRuntimeConfig(env: Env, app: AppsAppRow) {
  return syncReadyAppRuntimeConfig(env, app, "stream");
}

async function syncReadyAppRuntimeConfig(env: Env, app: AppsAppRow, capability: "mail" | "stream") {
  const rows = await env.APPS_DB
    .prepare(
      `
      SELECT *
      FROM apps_app_resources
      WHERE app_id = ?
        AND environment = 'prod'
        AND status = 'ready'
        AND type IN ('worker', 'pages_project', 'pages_function')
      ORDER BY CASE type WHEN 'worker' THEN 0 WHEN 'pages_project' THEN 1 ELSE 2 END, created_at
      `
    )
    .bind(app.id)
    .all<AppsResourceRow>();
  const runtime = rows.results?.[0];
  if (!runtime) {
    return { skipped: true };
  }

  if (runtime.type === "worker") {
    const scriptName = readString(runtime.resource_id || runtime.resource_name).trim();
    if (!scriptName) {
      throw new HttpError(409, "worker_resource_not_ready");
    }
    await syncWorkerRuntimeConfig(env, app, scriptName, capability);
    return { synced: true, target: "worker" as const };
  }

  const projectName = runtime.type === "pages_project"
    ? readString(runtime.resource_name || runtime.resource_id).trim()
    : `apps-${normalizeAppCode(app.code || app.slug || app.id)}-pages`;
  if (!projectName) {
    throw new HttpError(409, "pages_project_resource_not_ready");
  }
  await syncPagesProjectConfig(env, app, projectName);
  return { synced: true, target: "pages" as const };
}

async function syncWorkerRuntimeConfig(env: Env, app: AppsAppRow, scriptName: string, capability: "mail" | "stream") {
  const accountId = requireCloudflareAccountId(env);
  const projection = await runtimeProjection(env, app, "worker");
  const settings = await cloudflareFetch<Record<string, unknown>>(
    env,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`
  );
  const existingBindings = Array.isArray(settings.bindings)
    ? settings.bindings.map((binding) => asRecord(binding))
    : [];
  const managedNames = new Set(capability === "stream"
    ? ["STREAM", "WORKSPACE_STREAM", "WORKSPACE_STREAM_TOKEN", "CLOUDFLARE_STREAM_API_TOKEN"]
    : ["EMAIL", "WORKSPACE_EMAIL_FROM", "WORKSPACE_MAIL_TOKEN", "WORKSPACE_MAIL_ENDPOINT", "WORKSPACE_EMAIL_INBOUND_ADDRESS", "WORKSPACE_EMAIL_ROUTER_WORKER", "WORKSPACE_EMAIL_ROUTING_MODE", "WORKSPACE_MAIL_LEGACY_NATIVE_EMAIL", "WORKSPACE_MAIL_TRIGGER_ENABLED", "WORKSPACE_APP_ID"]);
  const desiredBindings = workerMetadataBindings(env, projection, app)
    .filter((binding) => managedNames.has(readString(binding.name).trim()));
  const bindings = [
    ...existingBindings
      .filter((binding) => !managedNames.has(readString(binding.name).trim()))
      .map((binding) => binding.type === "secret_text"
        ? { name: binding.name, type: "inherit" }
        : binding),
    ...desiredBindings
  ];
  const form = new FormData();
  form.set("settings", new Blob([JSON.stringify({ bindings })], { type: "application/json" }));

  await cloudflareFetch<Record<string, unknown>>(
    env,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
    {
      body: form,
      method: "PATCH"
    }
  );
}

async function uploadWorkerAssets(
  env: Env,
  accountId: string,
  scriptName: string,
  config: DeployArtifactWorkerAssets,
  files: CloudflareSourceFile[]
) {
  if (files.length === 0) throw new HttpError(400, "worker_assets_missing");
  const prefix = `${config.directory}/`;
  const assets = await Promise.all(files.map(async (file) => {
    const path = file.path.slice(prefix.length);
    const bytes = sourceFileBytes(file);
    return { file, path, bytes, hash: await pagesAssetHash({ ...file, path }, bytes) };
  }));
  const manifest = Object.fromEntries(assets.map((asset) => [`/${asset.path}`, {
    hash: asset.hash,
    size: asset.bytes.byteLength
  }]));
  const session = await cloudflareFetch<{ buckets?: string[][]; jwt?: string }>(
    env,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/assets-upload-session`,
    {
      body: JSON.stringify({ manifest }),
      headers: { "Content-Type": "application/json" },
      method: "POST"
    }
  );
  const uploadJwt = readString(session.jwt).trim();
  if (!uploadJwt) throw new HttpError(502, "worker_assets_upload_token_missing");
  const buckets = Array.isArray(session.buckets) ? session.buckets : [];
  let completionJwt = uploadJwt;
  for (const bucket of buckets) {
    if (isSingleAssetUploadJwt(uploadJwt)) {
      for (const hash of bucket) {
        const asset = assets.find((candidate) => candidate.hash === hash);
        if (!asset) throw new HttpError(502, "worker_assets_manifest_drift");
        const result = await cloudflareFetch<{ jwt?: string }>(
          env,
          `/accounts/${accountId}/workers/assets/upload/${encodeURIComponent(hash)}`,
          {
            body: asset.bytes,
            headers: {
              Authorization: `Bearer ${uploadJwt}`,
              "Content-Type": asset.file.contentType || "application/null"
            },
            method: "POST"
          }
        );
        completionJwt = readString(result.jwt).trim() || completionJwt;
      }
      continue;
    }
    const form = new FormData();
    for (const hash of bucket) {
      const asset = assets.find((candidate) => candidate.hash === hash);
      if (!asset) throw new HttpError(502, "worker_assets_manifest_drift");
      form.append(hash, new Blob([bytesToBase64(asset.bytes)], { type: asset.file.contentType }), hash);
    }
    const result = await cloudflareFetch<{ jwt?: string }>(env, `/accounts/${accountId}/workers/assets/upload?base64=true`, {
      body: form,
      headers: { Authorization: `Bearer ${uploadJwt}` },
      method: "POST"
    });
    completionJwt = readString(result.jwt).trim() || completionJwt;
  }
  if (!completionJwt) throw new HttpError(502, "worker_assets_completion_token_missing");
  return completionJwt;
}

function isSingleAssetUploadJwt(jwt: string) {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return false;
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(atob(padded)).wrangler_single_asset_uploads === true;
  } catch {
    return false;
  }
}

export async function rollbackCloudflareDeployment(env: Env, artifactKey: string) {
  await promoteCloudflareDeployment(env, artifactKey, "Workspace APPS rollback");
}

export async function promoteCloudflareDeployment(env: Env, artifactKey: string, message = "Workspace APPS publish") {
  const target = parseCloudflareArtifactKey(artifactKey);
  if (!target) {
    throw new HttpError(409, "deployment_cloudflare_target_missing");
  }

  const accountId = requireCloudflareAccountId(env);
  if (target.kind === "pages") {
    await cloudflareFetch<Record<string, unknown>>(
      env,
      `/accounts/${accountId}/pages/projects/${encodeURIComponent(target.resourceName)}/deployments/${encodeURIComponent(target.versionId)}/rollback`,
      {
        body: JSON.stringify({}),
        method: "POST"
      }
    );
    return;
  }

  await cloudflareFetch<Record<string, unknown>>(
    env,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(target.resourceName)}/deployments`,
    {
      body: JSON.stringify({
        annotations: {
          "workers/message": message
        },
        strategy: "percentage",
        versions: [
          {
            percentage: 100,
            version_id: target.versionId
          }
        ]
      }),
      method: "POST"
    }
  );
}

async function syncPagesProjectConfig(env: Env, app: AppsAppRow, projectName: string, existingProjection?: RuntimeProjection) {
  const accountId = requireCloudflareAccountId(env);
  const projection = existingProjection ?? await runtimeProjection(env, app, "pages");
  const project = await cloudflareFetch<Record<string, unknown>>(
    env,
    `/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`
  );
  const productionConfig = asRecord(asRecord(project.deployment_configs).production);
  const config: Record<string, unknown> = {
    compatibility_date: readString(productionConfig.compatibility_date) || CLOUDFLARE_COMPATIBILITY_DATE,
    compatibility_flags: pagesCompatibilityFlags(productionConfig, projection.bindings),
    d1_databases: pagesD1Bindings(projection.bindings),
    env_vars: pagesEnvVars(projection),
    hyperdrive_bindings: pagesHyperdriveBindings(projection.bindings),
    kv_namespaces: pagesKvBindings(projection.bindings),
    queue_producers: pagesQueueBindings(projection.bindings),
    r2_buckets: pagesR2Bindings(projection.bindings),
    send_email: pagesEmailBindings(projection),
    service_bindings: {
      ...asRecord(productionConfig.service_bindings),
      ...(projection.bindings.some(binding => binding.type === "media")
        ? { WORKSPACE_STREAM: { service: workspaceStreamWorkerName(env), environment: "production" } } : {})
    }
  };
  const wranglerConfigHash = readString(productionConfig.wrangler_config_hash).trim();
  if (wranglerConfigHash) {
    config.wrangler_config_hash = wranglerConfigHash;
  }

  await cloudflareFetch<Record<string, unknown>>(
    env,
    `/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`,
    {
      body: JSON.stringify({
        deployment_configs: {
          production: config
        }
      }),
      method: "PATCH"
    }
  );
}

async function latestWorkerVersionId(env: Env, accountId: string, scriptName: string) {
  const result = await cloudflareFetch<unknown>(
    env,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/deployments`
  );
  const resultRecord = asRecord(result);
  const deployments: unknown[] = Array.isArray(resultRecord.deployments) ? resultRecord.deployments : [];
  const latest = asRecord(deployments[0]);
  const versions = Array.isArray(latest.versions) ? latest.versions : [];
  return readString(asRecord(versions[0]).version_id).trim();
}

async function uploadPagesAssets(env: Env, accountId: string, projectName: string, files: CloudflareSourceFile[]) {
  if (files.length === 0) {
    return {};
  }

  const token = await cloudflareFetch<{ jwt?: string }>(
    env,
    `/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/upload-token`
  );
  const jwt = readString(token.jwt).trim();
  if (!jwt) {
    throw new HttpError(502, "pages_upload_token_missing");
  }

  const assets = await Promise.all(files.map(async (file) => {
    const bytes = sourceFileBytes(file);
    return { file, bytes, hash: await pagesAssetHash(file, bytes) };
  }));
  const hashes = assets.map((asset) => asset.hash);
  const missing = await cloudflareFetch<unknown>(env, "/pages/assets/check-missing", {
    body: JSON.stringify({ hashes }),
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });
  const missingHashes = new Set(readStringArray(missing));

  const uploadPayload = assets
    .filter((asset) => missingHashes.size === 0 || missingHashes.has(asset.hash))
    .map((asset) => ({
      base64: true,
      key: asset.hash,
      metadata: {
        contentType: asset.file.contentType
      },
      value: bytesToBase64(asset.bytes)
    }));

  if (uploadPayload.length > 0) {
    await cloudflareFetch<Record<string, unknown>>(env, "/pages/assets/upload", {
      body: JSON.stringify(uploadPayload),
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json"
      },
      method: "POST"
    });
  }

  await cloudflareFetch<Record<string, unknown>>(env, "/pages/assets/upsert-hashes", {
    body: JSON.stringify({ hashes }),
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });

  return Object.fromEntries(assets.map((asset) => [`/${asset.file.path}`, asset.hash]));
}

async function runtimeProjection(env: Env, app: AppsAppRow, target: "pages" | "worker"): Promise<RuntimeProjection> {
  const appId = app.id;
  // Also upgrades existing logical media registrations before projecting a runtime.
  // Every App receives only an App-scoped capability and a service binding.
  await provisionResourceTypes(env, app, ["media"], new Date().toISOString());
  const [resources, envVars, secrets] = await Promise.all([
    readyAppResources(env, appId),
    targetEnvVars(env, appId, target),
    configuredSecrets(env, appId)
  ]);

  const hasStream = resources.some(resource => resource.type === "media");
  return {
    bindings: resources
      .filter((resource) => resource.type === "d1_database" || resource.type === "kv_namespace" || resource.type === "r2_bucket" || resource.type === "email_sending" || resource.type === "hyperdrive_config" || resource.type === "queue" || resource.type === "media")
      .map((resource) => ({
        bindingName: bindingName(resource),
        resourceId: readString(resource.resource_id).trim(),
        resourceName: readString(resource.resource_name).trim(),
        type: resource.type
      }))
      .filter((binding) => binding.bindingName && binding.resourceId),
    envVars: mergeEnvVars(standardRuntimeEnvVars(env, app), envVars),
    secrets: hasStream ? secrets.filter(secret => secret.name !== "CLOUDFLARE_STREAM_API_TOKEN") : secrets
  };
}

function standardRuntimeEnvVars(env: Env, app: AppsAppRow) {
  const authOrigin = authIssuer(env);
  const fallbackRuntime = fallbackRuntimeUrls(env, normalizeAppCode(app.code || app.slug || app.id)).productionUrl;
  const values = [
    { name: "AUTH_ISSUER", value: authOrigin },
    { name: "AUTH_PUBLIC_URL", value: readString(env.AUTH_PUBLIC_URL).trim() || authOrigin },
    { name: "WORKSPACE_AUTH_AUTHORIZE_ORIGIN", value: readString(env.AUTH_PUBLIC_URL).trim() || authOrigin },
    { name: "WORKSPACE_AUTH_AUDIENCE", value: app.id },
    { name: "WORKSPACE_AUTH_CALLBACK_PATH", value: "/auth/workspace/callback" },
    { name: "WORKSPACE_AUTH_CLIENT_ID", value: app.id },
    { name: "WORKSPACE_AUTH_FALLBACK_PRODUCTION_URL", value: fallbackRuntime },
    { name: "WORKSPACE_AUTH_ORIGIN", value: authOrigin },
    { name: "WORKSPACE_AUTH_SESSION_ENDPOINT", value: "/api/auth/session" }
  ];
  return values.filter((item) => item.value);
}

function mergeEnvVars(base: Array<{ name: string; value: string }>, override: Array<{ name: string; value: string }>) {
  const values = new Map<string, string>();
  for (const item of base) {
    values.set(item.name, item.value);
  }
  for (const item of override) {
    values.set(item.name, item.value);
  }
  return Array.from(values.entries()).map(([name, value]) => ({ name, value }));
}

async function readyAppResources(env: Env, appId: string) {
  const rows = await env.APPS_DB
    .prepare("SELECT * FROM apps_app_resources WHERE app_id = ? AND environment = 'prod' AND status = 'ready' ORDER BY created_at")
    .bind(appId)
    .all<AppsResourceRow>();
  return rows.results ?? [];
}

async function requireReadyAppResource(env: Env, appId: string, type: string) {
  const row = await env.APPS_DB
    .prepare(
      `
      SELECT *
      FROM apps_app_resources
      WHERE app_id = ?
        AND type = ?
        AND environment = 'prod'
      ORDER BY CASE status WHEN 'ready' THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1
      `
    )
    .bind(appId, type)
    .first<AppsResourceRow>();
  if (!row) {
    throw new HttpError(409, `${type}_resource_not_enabled`);
  }
  if (row.status !== "ready" || !readString(row.resource_id || row.resource_name).trim()) {
    throw new HttpError(409, `${type}_resource_not_ready`);
  }
  return row;
}

async function targetEnvVars(env: Env, appId: string, target: "pages" | "worker") {
  const rows = await env.APPS_DB
    .prepare(
      `
      SELECT name, target, value
      FROM apps_app_env_vars
      WHERE app_id = ?
        AND environment = 'production'
        AND target IN ('runtime', ?)
      ORDER BY CASE target WHEN 'runtime' THEN 0 ELSE 1 END, name
      `
    )
    .bind(appId, target)
    .all<EnvVarRow>();

  const values = new Map<string, string>();
  for (const row of rows.results ?? []) {
    values.set(row.name, row.value);
  }
  return Array.from(values.entries()).map(([name, value]) => ({ name, value }));
}

async function configuredSecrets(env: Env, appId: string) {
  const rows = await env.APPS_DB
    .prepare("SELECT * FROM apps_app_secrets WHERE app_id = ? AND environment = 'production' ORDER BY name")
    .bind(appId)
    .all<AppsAppSecretRow>();

  const secrets = rows.results ?? [];
  if (secrets.some((secret) => secret.required === 1 && secret.status !== "configured")) {
    throw new HttpError(409, "required_secret_not_configured");
  }

  const configured = [];
  for (const secret of secrets.filter((item) => (
    item.status === "configured" && item.name !== APPS_HYPERDRIVE_PASSWORD_SECRET_NAME
  ))) {
    configured.push({
      name: secret.name,
      value: await decryptSecretValue(env, {
        algorithm: secret.algorithm,
        cipherIv: secret.cipher_iv,
        cipherText: secret.cipher_text
      })
    });
  }
  return configured;
}

function workerMetadataBindings(env: Env, projection: RuntimeProjection, app: AppsAppRow, assetsBinding?: string) {
  const bindings: Array<Record<string, unknown>> = [];
  for (const item of projection.envVars) {
    bindings.push({ name: item.name, text: item.value, type: "plain_text" });
  }
  for (const secret of projection.secrets) {
    bindings.push({ name: secret.name, text: secret.value, type: "secret_text" });
  }
  for (const resource of projection.bindings) {
    if (resource.type === "d1_database") {
      bindings.push({ id: resource.resourceId, name: resource.bindingName, type: "d1" });
    }
    if (resource.type === "kv_namespace") {
      bindings.push({ name: resource.bindingName, namespace_id: resource.resourceId, type: "kv_namespace" });
    }
    if (resource.type === "r2_bucket") {
      bindings.push({ bucket_name: resource.resourceName || resource.resourceId, name: resource.bindingName, type: "r2_bucket" });
    }
    if (resource.type === "hyperdrive_config") {
      bindings.push({ id: resource.resourceId, name: resource.bindingName, type: "hyperdrive" });
    }
    if (resource.type === "email_sending" && (!projection.secrets.some(secret=>secret.name === "WORKSPACE_MAIL_TOKEN") || projection.envVars.some(item=>item.name === "WORKSPACE_MAIL_LEGACY_NATIVE_EMAIL" && item.value === "1"))) {
      bindings.push(emailSendingBinding(resource.bindingName, projection));
    }
    if (resource.type === "queue") {
      bindings.push({ name: resource.bindingName, queue_name: resource.resourceName, type: "queue" });
    }
    if (resource.type === "media") {
      bindings.push({ name: WORKSPACE_STREAM_BINDING, type: "service", service: workspaceStreamWorkerName(env) });
    }
  }
  if (app.login_required === 1) {
    bindings.push({
      name: "AUTH_SERVICE",
      service: configuredWorkerName(env.WORKSPACE_AUTH_WORKER_NAME, "WORKSPACE_AUTH_WORKER_NAME"),
      type: "service"
    });
  }
  if (assetsBinding) {
    bindings.push({ name: assetsBinding, type: "assets" });
  }
  return bindings;
}

function emailSendingBinding(name: string, projection: RuntimeProjection) {
  const binding: Record<string, unknown> = {
    name,
    type: "send_email"
  };
  const allowedSenderAddresses = emailAllowedSenderAddresses(projection);
  if (allowedSenderAddresses.length > 0) {
    binding.allowed_sender_addresses = allowedSenderAddresses;
  }
  return binding;
}

function pagesEnvVars(projection: RuntimeProjection) {
  const envVars: Record<string, { type: string; value: string }> = {};
  for (const item of projection.envVars) {
    envVars[item.name] = { type: "plain_text", value: item.value };
  }
  for (const secret of projection.secrets) {
    envVars[secret.name] = { type: "secret_text", value: secret.value };
  }
  return envVars;
}

function pagesD1Bindings(bindings: RuntimeBinding[]) {
  const output: Record<string, { id: string }> = {};
  for (const binding of bindings.filter((item) => item.type === "d1_database")) {
    output[binding.bindingName] = { id: binding.resourceId };
  }
  return output;
}

function pagesKvBindings(bindings: RuntimeBinding[]) {
  const output: Record<string, { namespace_id: string }> = {};
  for (const binding of bindings.filter((item) => item.type === "kv_namespace")) {
    output[binding.bindingName] = { namespace_id: binding.resourceId };
  }
  return output;
}

function pagesR2Bindings(bindings: RuntimeBinding[]) {
  const output: Record<string, { name: string }> = {};
  for (const binding of bindings.filter((item) => item.type === "r2_bucket")) {
    output[binding.bindingName] = { name: binding.resourceName || binding.resourceId };
  }
  return output;
}

function pagesHyperdriveBindings(bindings: RuntimeBinding[]) {
  const output: Record<string, { id: string }> = {};
  for (const binding of bindings.filter((item) => item.type === "hyperdrive_config")) {
    output[binding.bindingName] = { id: binding.resourceId };
  }
  return output;
}

function pagesCompatibilityFlags(productionConfig: Record<string, unknown>, bindings: RuntimeBinding[]) {
  const existing = Array.isArray(productionConfig.compatibility_flags)
    ? productionConfig.compatibility_flags.map((flag) => readString(flag).trim()).filter(Boolean)
    : [];
  if (bindings.some((binding) => binding.type === "hyperdrive_config")) {
    existing.push("nodejs_compat");
  }
  return [...new Set(existing)];
}

function pagesQueueBindings(bindings: RuntimeBinding[]) {
  const output: Record<string, { name: string }> = {};
  for (const binding of bindings.filter((item) => item.type === "queue")) {
    output[binding.bindingName] = { name: binding.resourceName };
  }
  return output;
}

function pagesEmailBindings(projection: RuntimeProjection) {
  if(projection.secrets.some(secret=>secret.name === "WORKSPACE_MAIL_TOKEN") && !projection.envVars.some(item=>item.name === "WORKSPACE_MAIL_LEGACY_NATIVE_EMAIL" && item.value === "1"))return [];
  return projection.bindings
    .filter((binding) => binding.type === "email_sending")
    .map((binding) => {
      const output: Record<string, unknown> = { name: binding.bindingName };
      const allowedSenderAddresses = emailAllowedSenderAddresses(projection);
      if (allowedSenderAddresses.length > 0) {
        output.allowed_sender_addresses = allowedSenderAddresses;
      }
      return output;
    });
}

function emailAllowedSenderAddresses(projection: RuntimeProjection) {
  const senders = new Set<string>();
  for (const name of ["WORKSPACE_EMAIL_FROM"]) {
    const value = projection.envVars.find((item) => item.name === name)?.value;
    const sender = readString(value).trim().toLowerCase();
    if (isEmail(sender)) {
      senders.add(sender);
    }
  }
  return [...senders];
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function bindingName(resource: AppsResourceRow) {
  const explicit = readString(resource.binding_name).trim();
  if (explicit) {
    return explicit;
  }
  if (resource.type === "d1_database") {
    return "DB";
  }
  if (resource.type === "kv_namespace") {
    return "KV";
  }
  if (resource.type === "r2_bucket") {
    return "BUCKET";
  }
  if (resource.type === "hyperdrive_config") {
    return "HYPERDRIVE";
  }
  if (resource.type === "email_sending") {
    return "EMAIL";
  }
  if (resource.type === "queue") {
    return "QUEUE";
  }
  if (resource.type === "media") {
    return WORKSPACE_STREAM_BINDING;
  }
  return "";
}

function workerModuleContentType(file: CloudflareSourceFile) {
  if (file.path.endsWith(".js.map") || file.path.endsWith(".mjs.map") || file.path.endsWith(".ts.map")) {
    return "application/source-map";
  }
  if (file.path.endsWith(".js") || file.path.endsWith(".mjs") || file.path.endsWith(".ts")) {
    return "application/javascript+module";
  }
  return file.contentType;
}

function splitPagesDeploymentFiles(files: CloudflareSourceFile[]) {
  const deploymentNames = new Set([
    "_headers",
    "_redirects",
    "_routes.json",
    "_worker.bundle",
    "functions-filepath-routing-config.json"
  ]);
  return {
    assetFiles: files.filter((file) => !deploymentNames.has(file.path)),
    deploymentFiles: files.filter((file) => deploymentNames.has(file.path))
  };
}

async function pagesAssetHash(file: CloudflareSourceFile, bytes: Uint8Array) {
  const extension = file.path.includes(".") ? file.path.split(".").pop() || "" : "";
  const base64 = bytesToBase64(bytes);
  const digest = blake3(new TextEncoder().encode(`${base64}${extension}`));
  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function sourceFileBytes(file: CloudflareSourceFile) {
  if (file.encoding !== "base64") return new TextEncoder().encode(file.content);
  let binary: string;
  try {
    binary = atob(file.content);
  } catch {
    throw new HttpError(400, "invalid_base64_source_file");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function readStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => readString(item)).filter(Boolean);
  }
  const record = asRecord(value);
  if (Array.isArray(record.hashes)) {
    return record.hashes.map((item) => readString(item)).filter(Boolean);
  }
  return [];
}

function parseCloudflareArtifactKey(value: string) {
  const match = readString(value).match(/^cloudflare:\/\/(pages|workers)\/([^/]+)\/([^/]+)$/);
  if (!match) {
    return undefined;
  }
  return {
    kind: match[1] as "pages" | "workers",
    resourceName: match[2],
    versionId: match[3]
  };
}
