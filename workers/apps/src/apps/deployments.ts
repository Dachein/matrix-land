import type { AppsApp } from "../../../../src/shared/types";
import {
  WORKSPACE_RELEASE_READINESS_REPORT_NAME,
  WORKSPACE_RELEASE_READINESS_REPORT_SCHEMA,
  workspaceHarnessReportUrl,
  isWorkspaceHarnessReportUrl,
  isReleaseReadinessReportRequired
} from "../../../../src/shared/harnessReport";
import { cloudflareFetch, requireCloudflareAccountId } from "../cloudflare/client";
import { audit } from "../core/audit";
import { HttpError, type Env, type Principal } from "../core/types";
import { asRecord, normalizeAppCode, parseStringArray, randomToken, readOptionalString, readString, requireText } from "../core/utils";
import { runtimeUrls } from "../runtime/urls";
import { inspectAuthSecurityPreflight, type AuthSecurityPreflightReport } from "./authSecurityPreflight";
import { syncAppsAppAuthClient } from "./authSync";
import {
  deployPagesSourceToCloudflare,
  deployWorkerSourceToCloudflare,
  promoteCloudflareDeployment,
  rollbackCloudflareDeployment,
  syncCloudflareDeploymentTopology,
  type WorkerRuntimeTopology
} from "./cloudflareDeploy";
import { ensurePublishedAppDomain } from "../domains/cloudflare";
import { canReadApp, requireWritableApp } from "./queries";
import { configureHyperdriveForDeployment, provisionResourceTypes } from "../provisioning/cloudflareResources";
import type { AppsAppRow, AppsResourceRow } from "../db/rows";
import { ensureManagedAppAuthSecrets } from "./appAuthSecrets";
import { inspectAppMcpRegistration, syncPublishedAppMcpResource, type AppMcpRegistration } from "./appMcpRegistry";
import { loadDeployArtifact, type DeployArtifactWorkerAssets } from "./deployArtifacts";
import {
  parseMigrationStatements,
  validateMigrationStatement,
  type MigrationStatementAnalysis
} from "./migrationSql";

type SourceFileInput = {
  content?: unknown;
  contentType?: unknown;
  encoding?: unknown;
  path?: unknown;
};

type DeployAppSourceInput = {
  accessTargets?: unknown;
  appId?: unknown;
  cronSchedules?: unknown;
  deployArtifactId?: unknown;
  entrypoint?: unknown;
  files?: unknown;
  hyperdrive?: unknown;
  loginRequired?: unknown;
  queueConsumer?: unknown;
  releaseNotes?: unknown;
  sourceSnapshotId?: unknown;
  visibility?: unknown;
  version?: unknown;
  versionName?: unknown;
};

type ApplyAppMigrationInput = {
  allowDataMigrations?: unknown;
  appId?: unknown;
  contentSha256?: unknown;
  fileName?: unknown;
  sql?: unknown;
  tablePrefix?: unknown;
  version?: unknown;
};

type DeploymentInput = {
  accessTargets?: unknown;
  appId?: unknown;
  deploymentId?: unknown;
  harnessReportUrl?: unknown;
  harnessSelfCheckConfirmed?: unknown;
  loginRequired?: unknown;
  visibility?: unknown;
};

type AccessPolicyInput = Pick<DeployAppSourceInput, "accessTargets" | "loginRequired" | "visibility">;

type DeploymentAccessPolicy = {
  accessTargets: string[];
  loginRequired: boolean;
  visibility: "private" | "team" | "org" | "public";
};

type SourceFile = {
  content: string;
  contentType: string;
  encoding: "base64" | "text";
  path: string;
};

const MAX_SOURCE_FILES = 80;
// Worker deployments may legitimately embed immutable runtime assets (for
// example PDF form templates and subset fonts). Cloudflare applies its own
// compressed Worker-size limit at upload time, so keep the MCP envelope below
// the platform's request limit without rejecting valid Worker bundles first.
const MAX_SOURCE_FILE_BYTES = 20_000_000;
const MAX_SOURCE_BUNDLE_BYTES = 20_000_000;
const MAX_MIGRATION_SQL_BYTES = 80_000;

export async function deployAppSource(input: DeployAppSourceInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const row = await requireWritableApp(env.APPS_DB, principal, appId);
  const appCode = normalizeAppCode(row.code || row.slug || row.id);
  const sourceSnapshotId = await optionalSourceSnapshotId(env, appId, input.sourceSnapshotId);
  const version = deploymentVersion(input.version);
  const versionName = deploymentMetadataText(input.versionName, 160, "deployment_version_name_too_long");
  const releaseNotes = deploymentMetadataText(input.releaseNotes, 4_000, "deployment_release_notes_too_long");
  const resolvedSource = await resolveDeploymentSource(input, env, principal, appId, "pages");
  const files = resolvedSource.files;
  const deployArtifactId = resolvedSource.deployArtifact?.id;
  const entrypoint = normalizeSourcePath(input.entrypoint || resolvedSource.deployArtifact?.entrypoint || "index.html", "invalid_entrypoint");
  if (!files.some((file) => file.path === entrypoint)) {
    throw new HttpError(400, "missing_entrypoint_file");
  }
  const accessPolicy = desiredDeploymentAccessPolicy(input, row);
  const authSecurity = requireAuthSecurityPreflight(appId, files, entrypoint, accessPolicy.loginRequired);
  const mcpRegistration = await inspectAppMcpRegistration(row, files, env);
  await ensureDeploymentAuthSecrets(env, row, accessPolicy.loginRequired);

  const now = new Date().toISOString();
  const deploymentId = `dep_${randomToken(12)}`;
  const sourceVersionId = `src_${randomToken(12)}`;
  const legacyArtifactBytes = resolvedSource.deployArtifact ? undefined : new TextEncoder().encode(JSON.stringify({
    appId, appCode, createdAt: now, entrypoint, files, version
  }));
  if (legacyArtifactBytes && legacyArtifactBytes.byteLength > MAX_SOURCE_BUNDLE_BYTES) throw new HttpError(413, "source_bundle_too_large");
  const artifactSha256 = resolvedSource.deployArtifact?.archiveSha256 ?? await sha256Hex(legacyArtifactBytes!);
  const artifactSizeBytes = resolvedSource.deployArtifact?.contentSizeBytes ?? legacyArtifactBytes!.byteLength;
  const hyperdrive = await configureHyperdriveForDeployment(env, row, input.hyperdrive, now);
  const cloudflare = await deployPagesSourceToCloudflare({ app: row, entrypoint, files, version }, env);
  await syncReadyDeploymentAuth(env, row, accessPolicy);
  const artifactKey = cloudflare.artifactKey;
  const url = runtimeUrls(env, appCode).productionUrl;
  await recordSourceDeployment(env, principal, {
    appId,
    accessPolicy,
    artifactKey,
    artifactSha256,
    deployArtifactId,
    deploymentId,
    entrypoint,
    fileCount: files.length,
    now,
    mcpRegistration,
    sizeBytes: artifactSizeBytes,
    sourceSnapshotId,
    sourceVersionId,
    url,
    version,
    versionName,
    releaseNotes
  });

  await audit(env.APPS_DB, principal, "deployed app source via mcp", "apps_app", appId, {
    artifactKey,
    cloudflareDeploymentId: cloudflare.cloudflareDeploymentId,
    deploymentId,
    deployArtifactId,
    fileCount: files.length,
    hyperdriveConfigured: Boolean(hyperdrive),
    authSecurity: authSecurity.summary,
    version,
    versionName,
    releaseNotes
  });

  return {
    deployment: {
      id: deploymentId,
      appId,
      deployArtifactId,
      environment: "production",
      version,
      versionName,
      releaseNotes,
      status: "ready",
      sourceSnapshotId,
      url,
      createdBy: principal.sub,
      createdByName: readOptionalString(principal.name),
      createdAt: now,
      loginRequired: accessPolicy.loginRequired,
      visibility: accessPolicy.visibility,
      accessTargets: accessPolicy.accessTargets
    },
    sourceVersion: {
      id: sourceVersionId,
      appId,
      artifactKey,
      artifactSha256,
      entrypoint,
      fileCount: files.length,
      sizeBytes: artifactSizeBytes,
      version
    },
    resources: hyperdrive ? { hyperdrive } : undefined,
    security: { auth: authSecurity }
  };
}

export const deployPages = deployAppSource;

export async function deployWorkerSource(input: DeployAppSourceInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const row = await requireWritableApp(env.APPS_DB, principal, appId);
  const appCode = normalizeAppCode(row.code || row.slug || row.id);
  const sourceSnapshotId = await optionalSourceSnapshotId(env, appId, input.sourceSnapshotId);
  const version = deploymentVersion(input.version);
  const versionName = deploymentMetadataText(input.versionName, 160, "deployment_version_name_too_long");
  const releaseNotes = deploymentMetadataText(input.releaseNotes, 4_000, "deployment_release_notes_too_long");
  const resolvedSource = await resolveDeploymentSource(input, env, principal, appId, "worker");
  const files = resolvedSource.files;
  const deployArtifactId = resolvedSource.deployArtifact?.id;
  const entrypoint = normalizeSourcePath(input.entrypoint || resolvedSource.deployArtifact?.entrypoint || "index.js", "invalid_entrypoint");
  if (!files.some((file) => file.path === entrypoint)) {
    throw new HttpError(400, "missing_entrypoint_file");
  }
  const accessPolicy = desiredDeploymentAccessPolicy(input, row);
  const authSecurity = requireAuthSecurityPreflight(appId, files, entrypoint, accessPolicy.loginRequired);
  const mcpRegistration = await inspectAppMcpRegistration(row, files, env);
  await ensureDeploymentAuthSecrets(env, row, accessPolicy.loginRequired);

  const legacyArtifactBytes = resolvedSource.deployArtifact ? undefined : new TextEncoder().encode(JSON.stringify({
    appId, appCode, createdAt: new Date().toISOString(), entrypoint, files, version
  }));
  if (legacyArtifactBytes && legacyArtifactBytes.byteLength > MAX_SOURCE_BUNDLE_BYTES) throw new HttpError(413, "source_bundle_too_large");

  const now = new Date().toISOString();
  const deploymentId = `dep_${randomToken(12)}`;
  const sourceVersionId = `src_${randomToken(12)}`;
  const artifactSha256 = resolvedSource.deployArtifact?.archiveSha256 ?? await sha256Hex(legacyArtifactBytes!);
  const artifactSizeBytes = resolvedSource.deployArtifact?.contentSizeBytes ?? legacyArtifactBytes!.byteLength;
  const hyperdrive = await configureHyperdriveForDeployment(env, row, input.hyperdrive, now);
  const runtimeTopology = normalizeWorkerRuntimeTopology(input);
  const cloudflare = await deployWorkerSourceToCloudflare({
    app: row,
    entrypoint,
    files,
    version,
    assets: resolvedSource.manifest?.assets as DeployArtifactWorkerAssets | undefined,
    runtimeTopology
  }, env);
  await syncReadyDeploymentAuth(env, row, accessPolicy);
  const url = runtimeUrls(env, appCode).productionUrl;
  await recordSourceDeployment(env, principal, {
    appId,
    accessPolicy,
    artifactKey: cloudflare.artifactKey,
    artifactSha256,
    deployArtifactId,
    deploymentId,
    entrypoint,
    fileCount: files.length,
    now,
    mcpRegistration,
    sizeBytes: artifactSizeBytes,
    sourceSnapshotId,
    sourceVersionId,
    url,
    version,
    versionName,
    releaseNotes,
    runtimeTopology
  });

  await audit(env.APPS_DB, principal, "deployed worker source via mcp", "apps_app", appId, {
    artifactKey: cloudflare.artifactKey,
    cloudflareDeploymentId: cloudflare.cloudflareDeploymentId,
    deploymentId,
    deployArtifactId,
    fileCount: files.length,
    hyperdriveConfigured: Boolean(hyperdrive),
    authSecurity: authSecurity.summary,
    version,
    versionName,
    releaseNotes,
    runtimeTopology
  });

  return {
    deployment: {
      id: deploymentId,
      appId,
      deployArtifactId,
      environment: "production",
      version,
      versionName,
      releaseNotes,
      status: "ready",
      sourceSnapshotId,
      url,
      createdBy: principal.sub,
      createdByName: readOptionalString(principal.name),
      createdAt: now,
      loginRequired: accessPolicy.loginRequired,
      visibility: accessPolicy.visibility,
      accessTargets: accessPolicy.accessTargets
    },
    sourceVersion: {
      id: sourceVersionId,
      appId,
      artifactKey: cloudflare.artifactKey,
      artifactSha256,
      entrypoint,
      fileCount: files.length,
      sizeBytes: artifactSizeBytes,
      version
    },
    resources: hyperdrive ? { hyperdrive } : undefined,
    security: { auth: authSecurity }
  };
}

function normalizeWorkerRuntimeTopology(input: DeployAppSourceInput): WorkerRuntimeTopology | undefined {
  const cronSchedules = normalizeCronSchedules(input.cronSchedules);
  const queueConsumer = normalizeQueueConsumer(input.queueConsumer);
  if (!cronSchedules && !queueConsumer) return undefined;
  return {
    ...(cronSchedules ? { cronSchedules } : {}),
    ...(queueConsumer ? { queueConsumer } : {})
  };
}

function normalizeCronSchedules(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new HttpError(400, "invalid_cron_schedules");
  }
  const schedules = [...new Set(value.map((item) => readString(item).trim()))];
  if (schedules.some((cron) => (
    !cron
    || cron.length > 100
    || /[\u0000-\u001f\u007f]/.test(cron)
    || cron.split(/\s+/).length !== 5
  ))) {
    throw new HttpError(400, "invalid_cron_schedule");
  }
  return schedules;
}

function normalizeQueueConsumer(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_queue_consumer");
  }
  const record = asRecord(value);
  const bindingName = readString(record.bindingName).trim() || "QUEUE";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(bindingName)) {
    throw new HttpError(400, "invalid_queue_consumer_binding");
  }
  return {
    bindingName,
    maxBatchSize: boundedRuntimeInteger(record.maxBatchSize, 10, 1, 100, "invalid_queue_consumer_max_batch_size"),
    maxBatchTimeout: boundedRuntimeInteger(record.maxBatchTimeout, 5, 0, 60, "invalid_queue_consumer_max_batch_timeout"),
    maxRetries: boundedRuntimeInteger(record.maxRetries, 3, 0, 100, "invalid_queue_consumer_max_retries"),
    ...(record.maxConcurrency === undefined ? {} : {
      maxConcurrency: boundedRuntimeInteger(record.maxConcurrency, 1, 1, 250, "invalid_queue_consumer_max_concurrency")
    }),
    ...(record.retryDelay === undefined ? {} : {
      retryDelay: boundedRuntimeInteger(record.retryDelay, 0, 0, 43_200, "invalid_queue_consumer_retry_delay")
    })
  };
}

function boundedRuntimeInteger(value: unknown, fallback: number, minimum: number, maximum: number, code: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, code);
  }
  return parsed;
}

function requireAuthSecurityPreflight(appId: string, files: SourceFile[], entrypoint: string, loginRequired: boolean): AuthSecurityPreflightReport {
  const report = inspectAuthSecurityPreflight({
    entrypoint,
    loginRequired,
    sourceFiles: files
  });
  if (!report.ok) {
    console.warn("apps_app_auth_security_preflight_blocked", {
      appId,
      findingCodes: [...new Set(report.findings.map((finding) => finding.code))],
      summary: report.summary
    });
    throw new HttpError(422, "auth_security_preflight_failed", {
      security: { auth: report }
    });
  }
  return report;
}

async function ensureDeploymentAuthSecrets(env: Env, row: AppsAppRow, loginRequired: boolean) {
  if (!loginRequired) {
    return;
  }
  await ensureManagedAppAuthSecrets(env, row);
}

async function syncReadyDeploymentAuth(env: Env, row: AppsAppRow, accessPolicy: DeploymentAccessPolicy) {
  await syncAppsAppAuthClient(env, row, {
    accessTargets: accessPolicy.accessTargets,
    loginRequired: accessPolicy.loginRequired,
    sdkStatus: "connected",
    status: row.status === "published" ? "listed" : "draft",
    visibility: accessPolicy.visibility
  });
}

async function recordSourceDeployment(env: Env, principal: Principal, input: {
  accessPolicy: DeploymentAccessPolicy;
  appId: string;
  artifactKey: string;
  artifactSha256: string;
  deploymentId: string;
  deployArtifactId?: string;
  entrypoint: string;
  fileCount: number;
  now: string;
  mcpRegistration?: AppMcpRegistration;
  sizeBytes: number;
  sourceSnapshotId?: string;
  sourceVersionId: string;
  url: string;
  version: string;
  versionName: string;
  releaseNotes: string;
  runtimeTopology?: WorkerRuntimeTopology;
}) {
  await env.APPS_DB.batch([
    env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_deployments (
          id, app_id, source_snapshot_id, deploy_artifact_id, environment,
          version, version_name, release_notes, runtime_topology_json,
          login_required, visibility, access_targets_json, status, url,
          created_by, created_by_name, created_at
        )
        VALUES (?, ?, ?, ?, 'production', ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)
        `
      )
      .bind(
        input.deploymentId,
        input.appId,
        input.sourceSnapshotId ?? null,
        input.deployArtifactId ?? null,
        input.version,
        input.versionName,
        input.releaseNotes,
        input.runtimeTopology ? JSON.stringify(input.runtimeTopology) : "",
        input.accessPolicy.loginRequired ? 1 : 0,
        input.accessPolicy.visibility,
        JSON.stringify(input.accessPolicy.accessTargets),
        input.url,
        principal.sub,
        readString(principal.name),
        input.now
      ),
    ...(input.mcpRegistration ? [env.APPS_DB.prepare(`
      INSERT INTO apps_app_mcp_manifests (
        id, app_id, deployment_id, schema_version, tool_definition_version,
        manifest_sha256, manifest_json, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.mcpRegistration.id,
      input.appId,
      input.deploymentId,
      input.mcpRegistration.manifest.schemaVersion,
      input.mcpRegistration.manifest.toolDefinitionVersion,
      input.mcpRegistration.manifestSha256,
      input.mcpRegistration.manifestJson,
      principal.sub,
      input.now,
    )] : []),
    env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_app_source_versions (
          id,
          app_id,
          environment,
          version,
          deployment_id,
          artifact_key,
          artifact_sha256,
          entrypoint,
          file_count,
          size_bytes,
          created_by,
          created_at
        )
        VALUES (?, ?, 'production', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        input.sourceVersionId,
        input.appId,
        input.version,
        input.deploymentId,
        input.artifactKey,
        input.artifactSha256,
        input.entrypoint,
        input.fileCount,
        input.sizeBytes,
        principal.sub,
        input.now
      ),
    env.APPS_DB
      .prepare("UPDATE apps_apps SET updated_at = ? WHERE id = ?")
      .bind(input.now, input.appId)
  ]);
}

async function optionalSourceSnapshotId(env: Env, appId: string, value: unknown) {
  const sourceSnapshotId = readString(value).trim();
  if (!sourceSnapshotId) return undefined;
  const row = await env.APPS_DB
    .prepare("SELECT id FROM apps_app_source_snapshots WHERE app_id = ? AND id = ? LIMIT 1")
    .bind(appId, sourceSnapshotId)
    .first<{ id: string }>();
  if (!row) throw new HttpError(404, "source_snapshot_not_found");
  return row.id;
}

export async function applyAppMigration(input: ApplyAppMigrationInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const row = await requireWritableApp(env.APPS_DB, principal, appId);
  const version = migrationVersion(input.version);
  const sql = readString(input.sql);
  if (!sql.trim()) throw new HttpError(400, "missing_migration_sql");
  const sqlBytes = new TextEncoder().encode(sql);
  if (sqlBytes.byteLength > MAX_MIGRATION_SQL_BYTES) throw new HttpError(413, "migration_sql_too_large");
  const contentSha256 = await sha256Hex(sqlBytes);
  const declaredContentSha256 = readString(input.contentSha256).trim().toLowerCase();
  if (declaredContentSha256 && !/^[a-f0-9]{64}$/.test(declaredContentSha256)) {
    throw new HttpError(400, "invalid_migration_content_sha256");
  }
  if (declaredContentSha256 && declaredContentSha256 !== contentSha256) {
    throw new HttpError(400, "migration_content_sha256_mismatch");
  }
  const fileName = migrationFileName(input.fileName, version);
  const appCode = normalizeAppCode(row.code || row.slug || row.id);
  const prefixOptions = { allowWorkspacePrefix: appCode.startsWith("workspace-") };
  const appPrefix = normalizeTablePrefix(`${appCode.replaceAll("-", "_")}_`, prefixOptions);
  const declaredTablePrefix = readString(input.tablePrefix).trim();
  if (declaredTablePrefix && normalizeTablePrefix(declaredTablePrefix, prefixOptions) !== appPrefix) {
    throw new HttpError(400, "invalid_app_table_prefix");
  }
  const statements = parseMigrationStatements(sql);
  if (statements.length === 0) {
    throw new HttpError(400, "empty_migration");
  }

  const analyses = statements.map((statement) => validateMigrationStatement(statement, {
    allowDataMigrations: input.allowDataMigrations === true,
    tablePrefix: appPrefix
  }));
  const impact = migrationImpact(analyses);

  const existing = await env.APPS_DB
    .prepare(
      `
      SELECT id, content_sha256 AS contentSha256, file_name AS fileName
      FROM apps_migration_registry
      WHERE app_id = ?
        AND environment = 'production'
        AND version = ?
      LIMIT 1
      `
    )
    .bind(appId, version)
    .first<{ contentSha256?: string; fileName?: string; id: string }>();
  if (existing) {
    if (readString(existing.contentSha256).trim().toLowerCase() === contentSha256) {
      return {
        deduplicated: true,
        migration: {
          id: existing.id,
          appId,
          contentSha256,
          environment: "production",
          fileName: readString(existing.fileName).trim() || fileName,
          impact,
          status: "applied",
          tablePrefix: appPrefix,
          version
        }
      };
    }
    if (readString(existing.contentSha256).trim()) {
      throw new HttpError(409, "migration_content_drift");
    }
    throw new HttpError(409, "migration_version_exists");
  }

  await provisionResourceTypes(env, row, ["d1_database"], new Date().toISOString());
  const d1Resource = await requireReadyAppResource(env, appId, "d1_database");
  const now = new Date().toISOString();
  const migrationId = `mig_${randomToken(12)}`;
  await executeD1Batch(env, d1Resource, statements);
  await env.APPS_DB
    .prepare(
      `
      INSERT INTO apps_migration_registry (
        id, app_id, environment, version, status, content_sha256, file_name, created_by, created_at
      )
      VALUES (?, ?, 'production', ?, 'applied', ?, ?, ?, ?)
      `
    )
    .bind(migrationId, appId, version, contentSha256, fileName, principal.sub, now)
    .run();

  await audit(env.APPS_DB, principal, "applied app migration via mcp", "apps_app", appId, {
    statementCount: statements.length,
    impact,
    tablePrefix: appPrefix,
    contentSha256,
    fileName,
    version
  });

  return {
    deduplicated: false,
    migration: {
      id: migrationId,
      appId,
      contentSha256,
      environment: "production",
      fileName,
      impact,
      status: "applied",
      statementCount: statements.length,
      tablePrefix: appPrefix,
      version
    }
  };
}

export const applyD1Migration = applyAppMigration;

export async function listDeployments(input: DeploymentInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  await requireReadableApp(env, principal, appId);
  const rows = await env.APPS_DB
    .prepare("SELECT * FROM apps_deployments WHERE app_id = ? AND environment = 'production' ORDER BY created_at DESC")
    .bind(appId)
    .all<{
      app_id: string;
      access_targets_json?: string;
      created_at: string;
      created_by: string;
      created_by_name?: string;
      deploy_artifact_id?: string;
      environment: string;
      harness_report_url?: string;
      harness_self_check_confirmed_at?: string;
      harness_self_check_confirmed_by?: string;
      id: string;
      login_required?: number;
      source_snapshot_id?: string;
      release_notes?: string;
      status: string;
      url?: string;
      visibility?: string;
      version: string;
      version_name?: string;
    }>();
  return { deployments: (rows.results ?? []).map(deploymentFromRow) };
}

export async function getDeployment(input: DeploymentInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const deploymentId = requireText(input.deploymentId, "missing_deployment_id", 120);
  await requireReadableApp(env, principal, appId);
  const deployment = await readDeployment(env, appId, deploymentId);
  return { deployment };
}

export async function publishDeployment(input: DeploymentInput, env: Env, principal: Principal) {
  return promoteDeployment(input, env, principal, "published deployment via mcp");
}

export async function rollbackDeployment(input: DeploymentInput, env: Env, principal: Principal) {
  return promoteDeployment(input, env, principal, "rolled back deployment via mcp", { rollbackCloudflare: true });
}

export async function listD1Migrations(input: ApplyAppMigrationInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  await requireReadableApp(env, principal, appId);
  const rows = await env.APPS_DB
    .prepare(
      `
      SELECT id,
             app_id AS appId,
             environment,
             version,
             status,
             content_sha256 AS contentSha256,
             file_name AS fileName,
             created_by AS createdBy,
             created_at AS createdAt
      FROM apps_migration_registry
      WHERE app_id = ?
        AND environment = 'production'
      ORDER BY created_at DESC
      `
    )
    .bind(appId)
    .all<Record<string, unknown>>();
  return { migrations: rows.results ?? [] };
}

export async function getD1Schema(input: ApplyAppMigrationInput, env: Env, principal: Principal) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const row = await requireReadableApp(env, principal, appId);
  const d1Resource = await requireReadyAppResource(env, appId, "d1_database");
  if (d1Resource.provider !== "cloudflare-d1") {
    throw new HttpError(409, "d1_resource_not_reconciled");
  }
  const appCode = normalizeAppCode(row.code || row.slug || row.id);
  const tablePrefix = normalizeTablePrefix(
    input.tablePrefix || `${appCode.replaceAll("-", "_")}_`,
    { allowWorkspacePrefix: appCode.startsWith("workspace-") }
  );
  const tables = await queryD1Rows<{ name: string; sql?: string }>(
    env,
    d1Resource,
    `
    SELECT name,
           sql
    FROM sqlite_master
    WHERE type IN ('table', 'index')
      AND name LIKE '${escapeSqlLike(tablePrefix)}%' ESCAPE '\\'
    ORDER BY type, name
    `
  );
  return {
    schema: {
      appId,
      tablePrefix,
      objects: tables.filter((item) => readString(item.sql).trim())
    }
  };
}

export async function appSourceRuntimeResponse(request: Request, env: Env, app: AppsApp, appPath: string): Promise<Response | undefined> {
  if (!env.APPS_ARTIFACTS) {
    return undefined;
  }

  const source = await latestAppSource(env, app.id);
  if (!source) {
    return undefined;
  }

  const artifact = await env.APPS_ARTIFACTS.get(source.artifactKey);
  if (!artifact) {
    return undefined;
  }

  const payload = asRecord(JSON.parse(await artifact.text()));
  const files = Array.isArray(payload.files) ? payload.files.map((file) => asRecord(file)) : [];
  const requestedPath = normalizeRuntimePath(appPath, source.entrypoint);
  const file = files.find((item) => readString(item.path) === requestedPath);
  if (!file) {
    return undefined;
  }

  return new Response(request.method === "HEAD" ? null : readString(file.content), {
    headers: {
      "cache-control": "no-store",
      "content-type": readOptionalString(file.contentType) || contentTypeForPath(requestedPath)
    }
  });
}

async function latestAppSource(env: Env, appId: string) {
  return env.APPS_DB
    .prepare(
      `
      SELECT artifact_key AS artifactKey,
             entrypoint
      FROM apps_app_source_versions
      JOIN apps_deployments
        ON apps_deployments.id = apps_app_source_versions.deployment_id
      WHERE apps_app_source_versions.app_id = ?
        AND apps_app_source_versions.environment = 'production'
        AND apps_deployments.status = 'published'
      ORDER BY apps_deployments.created_at DESC
      LIMIT 1
      `
    )
    .bind(appId)
    .first<{ artifactKey: string; entrypoint: string }>();
}

async function requireReadableApp(env: Env, principal: Principal, appId: string): Promise<AppsAppRow> {
  const row = await env.APPS_DB.prepare("SELECT * FROM apps_apps WHERE id = ? LIMIT 1").bind(appId).first<AppsAppRow>();
  if (!row || !canReadApp(row, principal)) {
    throw new HttpError(404, "apps_app_not_found");
  }
  return row;
}

async function requireReadyAppResource(env: Env, appId: string, type: string): Promise<AppsResourceRow> {
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
  if (row.status !== "ready" || !readString(row.resource_id).trim()) {
    throw new HttpError(409, `${type}_resource_not_ready`);
  }
  if (type === "d1_database" && row.provider !== "cloudflare-d1") {
    throw new HttpError(409, "d1_database_resource_provider_invalid");
  }
  return row;
}

async function executeD1Batch(env: Env, resource: AppsResourceRow, statements: string[]) {
  const accountId = requireCloudflareAccountId(env);
  const databaseId = encodeURIComponent(readString(resource.resource_id).trim());
  const results = await cloudflareFetch<Array<{ success?: boolean }>>(
    env,
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      body: JSON.stringify({ batch: statements.map((sql) => ({ sql })) })
    }
  );
  if (
    !Array.isArray(results)
    || results.length !== statements.length
    || results.some((result) => result?.success !== true)
  ) {
    throw new HttpError(502, "d1_migration_batch_failed");
  }
}

async function queryD1Rows<T>(env: Env, resource: AppsResourceRow, sql: string): Promise<T[]> {
  const accountId = requireCloudflareAccountId(env);
  const databaseId = encodeURIComponent(readString(resource.resource_id).trim());
  const result = await cloudflareFetch<unknown>(env, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql })
  });
  return d1ResultRows<T>(result);
}

async function promoteDeployment(input: DeploymentInput, env: Env, principal: Principal, auditAction: string, options: { rollbackCloudflare?: boolean } = {}) {
  const appId = requireText(input.appId, "missing_app_id", 120);
  const app = await requireWritableApp(env.APPS_DB, principal, appId);
  const deploymentId = readString(input.deploymentId).trim() || await latestReadyDeploymentId(env, appId);
  if (!deploymentId) {
    throw new HttpError(404, "deployment_not_found");
  }
  const deployment = await readDeployment(env, appId, deploymentId);
  if (deployment.status !== "ready" && deployment.status !== "published" && deployment.status !== "superseded") {
    throw new HttpError(409, "deployment_not_publishable");
  }

  const snapshotPolicy = deploymentAccessPolicy(deployment);
  const requestedPolicy = desiredDeploymentAccessPolicy(input, app, snapshotPolicy);
  if (snapshotPolicy && !sameAccessPolicy(snapshotPolicy, requestedPolicy)) {
    throw new HttpError(409, "deployment_access_policy_mismatch");
  }
  const { accessTargets, loginRequired, visibility } = requestedPolicy;
  if (app.type === "static_page" && (visibility === "private" || visibility === "team" || accessTargets.length > 0) && !loginRequired) {
    throw new HttpError(400, "static_page_private_auth_required");
  }
  if (!snapshotPolicy && loginRequired !== (app.login_required === 1)) {
    throw new HttpError(409, "auth_policy_change_requires_redeployment");
  }
  const now = new Date().toISOString();
  const releaseReadiness = options.rollbackCloudflare
    ? undefined
    : resolveDeploymentReleaseReadiness(
        input,
        deployment.url,
        principal,
        now,
        isReleaseReadinessReportRequired(env.WORKSPACE_RELEASE_READINESS_REPORT_REQUIRED)
      );
  if (options.rollbackCloudflare) {
    const artifactKey = await deploymentArtifactKey(env, appId, deploymentId);
    await rollbackCloudflareDeployment(env, artifactKey);
    await syncCloudflareDeploymentTopology(
      env,
      app,
      artifactKey,
      await deploymentRuntimeTopology(env, appId, deploymentId)
    );
  } else {
    const artifactKey = await deploymentArtifactKey(env, appId, deploymentId);
    if (artifactKey.startsWith("cloudflare://workers/")) {
      await promoteCloudflareDeployment(env, artifactKey);
      await syncCloudflareDeploymentTopology(
        env,
        app,
        artifactKey,
        await deploymentRuntimeTopology(env, appId, deploymentId)
      );
    }
  }
  // Reconcile the canonical hostname on every publish/rollback. Pages may
  // leave the custom domain initializing until its first release, and its
  // hostname also needs to bypass the account-wide APPS wildcard Worker.
  const productionDomain = await env.APPS_DB
    .prepare("SELECT hostname FROM apps_domains WHERE app_id = ? AND type = 'production' LIMIT 1")
    .bind(app.id)
    .first<{ hostname?: string }>();
  if (productionDomain?.hostname?.trim()) {
    await ensurePublishedAppDomain(env, app.id);
  }
  await syncAppsAppAuthClient(env, app, { accessTargets, loginRequired, visibility });
  await syncPublishedAppMcpResource(env, app, deploymentId, { accessTargets, visibility });
  const deploymentStatusStatement = releaseReadiness
    ? env.APPS_DB
        .prepare(
          `
          UPDATE apps_deployments
          SET status = 'published',
              harness_report_url = ?,
              harness_self_check_confirmed_at = ?,
              harness_self_check_confirmed_by = ?
          WHERE app_id = ? AND environment = 'production' AND id = ?
          `
        )
        .bind(releaseReadiness.reportUrl, releaseReadiness.confirmedAt, releaseReadiness.confirmedBy, appId, deploymentId)
    : env.APPS_DB
        .prepare("UPDATE apps_deployments SET status = 'published' WHERE app_id = ? AND environment = 'production' AND id = ?")
        .bind(appId, deploymentId);
  await env.APPS_DB.batch([
    env.APPS_DB
      .prepare("UPDATE apps_deployments SET status = 'superseded' WHERE app_id = ? AND environment = 'production' AND status = 'published' AND id != ?")
      .bind(appId, deploymentId),
    deploymentStatusStatement,
    env.APPS_DB
      .prepare("UPDATE apps_apps SET status = 'published', visibility = ?, login_required = ?, access_targets_json = ?, updated_at = ? WHERE id = ?")
      .bind(visibility, loginRequired ? 1 : 0, JSON.stringify(accessTargets), now, appId)
  ]);
  await audit(env.APPS_DB, principal, auditAction, "apps_app", appId, {
    accessTargets,
    deploymentId,
    loginRequired,
    ...(releaseReadiness ? {
      harnessReportName: releaseReadiness.reportName,
      harnessReportSchemaVersion: releaseReadiness.schemaVersion,
      harnessReportUrl: releaseReadiness.reportUrl,
      harnessSelfCheckConfirmed: releaseReadiness.selfCheckConfirmed
    } : {}),
    visibility
  });
  return { deployment: await readDeployment(env, appId, deploymentId) };
}

async function deploymentArtifactKey(env: Env, appId: string, deploymentId: string) {
  const row = await env.APPS_DB
    .prepare(
      `
      SELECT artifact_key AS artifactKey
      FROM apps_app_source_versions
      WHERE app_id = ?
        AND deployment_id = ?
        AND environment = 'production'
      LIMIT 1
      `
    )
    .bind(appId, deploymentId)
    .first<{ artifactKey: string }>();
  if (!row?.artifactKey) {
    throw new HttpError(409, "deployment_source_not_found");
  }
  return row.artifactKey;
}

async function deploymentRuntimeTopology(env: Env, appId: string, deploymentId: string) {
  const row = await env.APPS_DB
    .prepare(
      "SELECT runtime_topology_json AS runtimeTopologyJson FROM apps_deployments WHERE app_id = ? AND id = ? AND environment = 'production' LIMIT 1"
    )
    .bind(appId, deploymentId)
    .first<{ runtimeTopologyJson?: string }>();
  const value = readString(row?.runtimeTopologyJson).trim();
  if (!value) return undefined;
  try {
    return normalizeWorkerRuntimeTopology(JSON.parse(value) as DeployAppSourceInput);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, "deployment_runtime_topology_invalid");
  }
}

async function latestReadyDeploymentId(env: Env, appId: string) {
  const row = await env.APPS_DB
    .prepare("SELECT id FROM apps_deployments WHERE app_id = ? AND environment = 'production' AND status = 'ready' ORDER BY created_at DESC LIMIT 1")
    .bind(appId)
    .first<{ id: string }>();
  return row?.id ?? "";
}

async function readDeployment(env: Env, appId: string, deploymentId: string) {
  const row = await env.APPS_DB
    .prepare("SELECT * FROM apps_deployments WHERE app_id = ? AND id = ? AND environment = 'production' LIMIT 1")
    .bind(appId, deploymentId)
    .first<{
      app_id: string;
      access_targets_json?: string;
      created_at: string;
      created_by: string;
      created_by_name?: string;
      deploy_artifact_id?: string;
      environment: string;
      harness_report_url?: string;
      harness_self_check_confirmed_at?: string;
      harness_self_check_confirmed_by?: string;
      id: string;
      login_required?: number;
      source_snapshot_id?: string;
      release_notes?: string;
      status: string;
      url?: string;
      visibility?: string;
      version: string;
      version_name?: string;
    }>();
  if (!row) {
    throw new HttpError(404, "deployment_not_found");
  }
  return deploymentFromRow(row);
}

function deploymentFromRow(row: {
  app_id: string;
  access_targets_json?: string;
  created_at: string;
  created_by: string;
  created_by_name?: string;
  deploy_artifact_id?: string;
  environment: string;
  harness_report_url?: string;
  harness_self_check_confirmed_at?: string;
  harness_self_check_confirmed_by?: string;
  id: string;
  login_required?: number;
  source_snapshot_id?: string;
  release_notes?: string;
  status: string;
  url?: string;
  visibility?: string;
  version: string;
  version_name?: string;
}) {
  return {
    appId: row.app_id,
    deployArtifactId: readOptionalString(row.deploy_artifact_id),
    sourceSnapshotId: readOptionalString(row.source_snapshot_id),
    createdAt: row.created_at,
    createdBy: row.created_by,
    environment: "production",
    harnessReportUrl: readOptionalString(row.harness_report_url),
    harnessSelfCheckConfirmedAt: readOptionalString(row.harness_self_check_confirmed_at),
    harnessSelfCheckConfirmedBy: readOptionalString(row.harness_self_check_confirmed_by),
    id: row.id,
    accessTargets: row.access_targets_json === undefined ? undefined : parseStringArray(row.access_targets_json),
    loginRequired: row.login_required === undefined || row.login_required === null ? undefined : row.login_required === 1,
    releaseNotes: readOptionalString(row.release_notes),
    status: row.status,
    url: readOptionalString(row.url),
    visibility: readOptionalString(row.visibility),
    version: row.version,
    versionName: readOptionalString(row.version_name),
    createdByName: readOptionalString(row.created_by_name)
  };
}

function resolveDeploymentReleaseReadiness(
  input: DeploymentInput,
  productionUrl: unknown,
  principal: Principal,
  confirmationTime: string,
  required: boolean
) {
  const reportUrl = readString(input.harnessReportUrl).trim();
  const expectedReportUrl = workspaceHarnessReportUrl(productionUrl);
  if (!reportUrl && !required) {
    return undefined;
  }
  if (!expectedReportUrl || !isWorkspaceHarnessReportUrl(reportUrl, productionUrl)) {
    throw new HttpError(400, "invalid_harness_report_url");
  }
  const selfCheckConfirmed = input.harnessSelfCheckConfirmed === true;
  if (required && !selfCheckConfirmed) {
    throw new HttpError(409, "harness_self_check_required");
  }

  return {
    confirmedAt: selfCheckConfirmed ? confirmationTime : null,
    confirmedBy: selfCheckConfirmed ? principal.sub : "",
    reportName: WORKSPACE_RELEASE_READINESS_REPORT_NAME,
    reportUrl: expectedReportUrl,
    schemaVersion: WORKSPACE_RELEASE_READINESS_REPORT_SCHEMA,
    selfCheckConfirmed
  };
}

function normalizeVisibility(value: unknown) {
  const visibility = readString(value).trim();
  if (visibility === "private" || visibility === "team" || visibility === "org" || visibility === "public") {
    return visibility;
  }
  throw new HttpError(400, "invalid_visibility");
}

function desiredDeploymentAccessPolicy(
  input: AccessPolicyInput,
  app: AppsAppRow,
  fallback?: DeploymentAccessPolicy
): DeploymentAccessPolicy {
  const loginRequired = input.loginRequired === undefined
    ? fallback?.loginRequired ?? app.login_required === 1
    : input.loginRequired !== false;
  if (!loginRequired) {
    return { accessTargets: [], loginRequired: false, visibility: "public" };
  }

  const rawVisibility = readString(input.visibility).trim();
  const visibility = normalizeVisibility(rawVisibility || fallback?.visibility || (app.login_required === 1 ? app.visibility : "private"));
  if (visibility === "public") {
    throw new HttpError(400, "authenticated_access_scope_required");
  }
  const accessTargets = publishAccessTargets(input, app, visibility, fallback?.accessTargets);
  if (visibility === "team" && accessTargets.length === 0) {
    throw new HttpError(400, "access_targets_required");
  }
  return { accessTargets, loginRequired: true, visibility };
}

function deploymentAccessPolicy(deployment: {
  accessTargets?: string[];
  loginRequired?: boolean;
  visibility?: string;
}): DeploymentAccessPolicy | undefined {
  if (deployment.loginRequired === undefined || !deployment.visibility) return undefined;
  return {
    accessTargets: deployment.accessTargets ?? [],
    loginRequired: deployment.loginRequired,
    visibility: normalizeVisibility(deployment.visibility)
  };
}

function sameAccessPolicy(left: DeploymentAccessPolicy, right: DeploymentAccessPolicy) {
  return left.loginRequired === right.loginRequired
    && left.visibility === right.visibility
    && JSON.stringify([...left.accessTargets].sort()) === JSON.stringify([...right.accessTargets].sort());
}

function publishAccessTargets(input: AccessPolicyInput, app: AppsAppRow, visibility: string, fallback?: string[]) {
  if (input.accessTargets !== undefined) {
    if (!Array.isArray(input.accessTargets)) {
      throw new HttpError(400, "invalid_access_targets");
    }
    return normalizeAccessTargets(input.accessTargets);
  }

  if (readString(input.visibility).trim() && (visibility === "org" || visibility === "public")) {
    return [];
  }

  return fallback ?? normalizeAccessTargets(parseStringArray(app.access_targets_json));
}

function normalizeAccessTargets(value: unknown[]) {
  return Array.from(new Set(value.map((target) => readString(target).trim()).filter(Boolean))).slice(0, 200);
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function escapeSqlLike(value: string) {
  return escapeLike(value).replaceAll("'", "''");
}

function d1ResultRows<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    const first = asRecord(value[0]);
    if (Array.isArray(first.results)) {
      return first.results as T[];
    }
    return value as T[];
  }
  const record = asRecord(value);
  if (Array.isArray(record.results)) {
    return record.results as T[];
  }
  return [];
}

function deploymentVersion(value: unknown) {
  const text = readString(value).trim();
  if (text && /^[a-zA-Z0-9._-]{1,80}$/.test(text)) {
    return text;
  }
  if (text) {
    throw new HttpError(400, "invalid_deployment_version");
  }
  return `mcp-${Date.now()}`;
}

function deploymentMetadataText(value: unknown, maxLength: number, code: string) {
  const text = readString(value).trim();
  if (text.length > maxLength) throw new HttpError(400, code);
  return text;
}

function migrationVersion(value: unknown) {
  const text = readString(value).trim();
  if (!text) {
    throw new HttpError(400, "missing_migration_version");
  }
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(text)) {
    throw new HttpError(400, "invalid_migration_version");
  }
  return text;
}

function migrationFileName(value: unknown, version: string) {
  const fileName = readString(value).trim() || `${version}.sql`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.sql$/.test(fileName)) {
    throw new HttpError(400, "invalid_migration_file_name");
  }
  return fileName;
}

async function resolveDeploymentSource(
  input: DeployAppSourceInput,
  env: Env,
  principal: Principal,
  appId: string,
  target: "pages" | "worker"
) {
  const deployArtifactId = readString(input.deployArtifactId).trim();
  if (!deployArtifactId) {
    return { files: normalizeSourceFiles(input.files), deployArtifact: undefined, manifest: undefined };
  }
  if (input.files !== undefined) throw new HttpError(400, "ambiguous_deployment_source");
  return loadDeployArtifact(env, principal, appId, deployArtifactId, target);
}

function normalizeSourceFiles(value: unknown): SourceFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "missing_source_files");
  }
  if (value.length > MAX_SOURCE_FILES) {
    throw new HttpError(413, "too_many_source_files");
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  return value.map((item) => {
    const record = item && typeof item === "object" && !Array.isArray(item) ? item as SourceFileInput : {};
    const path = normalizeSourcePath(record.path, "invalid_source_path");
    if (seen.has(path)) {
      throw new HttpError(400, "duplicate_source_path");
    }
    seen.add(path);

    const content = readString(record.content);
    const size = new TextEncoder().encode(content).byteLength;
    if (size > MAX_SOURCE_FILE_BYTES) {
      throw new HttpError(413, "source_file_too_large");
    }
    totalBytes += size;
    if (totalBytes > MAX_SOURCE_BUNDLE_BYTES) {
      throw new HttpError(413, "source_bundle_too_large");
    }

    return {
      content,
      contentType: normalizeContentType(record.contentType, path),
      encoding: "text",
      path
    };
  });
}

function normalizeSourcePath(value: unknown, code: string) {
  const path = readString(value).trim().replace(/^\/+/, "");
  if (
    !path
    || path.length > 180
    || path.includes("\\")
    || path.split("/").some((part) => !part || part === "." || part === "..")
    || !/^[a-zA-Z0-9._~/-]+$/.test(path)
  ) {
    throw new HttpError(400, code);
  }
  return path;
}

function normalizeContentType(value: unknown, path: string) {
  const text = readString(value).trim().toLowerCase();
  if (text && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;\s*charset=[a-z0-9_-]+)?$/.test(text)) {
    return text.slice(0, 120);
  }
  return contentTypeForPath(path);
}

function contentTypeForPath(path: string) {
  if (path.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (path.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (path.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (path.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (path.endsWith(".svg")) {
    return "image/svg+xml; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

function normalizeRuntimePath(appPath: string, entrypoint: string) {
  const path = readString(appPath).replace(/^\/+/, "");
  return !path || path.endsWith("/") ? entrypoint : normalizeSourcePath(path, "invalid_runtime_path");
}

function normalizeTablePrefix(value: unknown, options: { allowWorkspacePrefix?: boolean } = {}) {
  const prefix = readString(value).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,40}_$/.test(prefix)) {
    throw new HttpError(400, "invalid_table_prefix");
  }
  const reserved = [
    "auth_",
    "cf_",
    "d1_",
    ...(options.allowWorkspacePrefix ? [] : ["workspace_"]),
    "apps_",
    "sqlite_",
    "users_"
  ];
  if (reserved.some((item) => prefix.startsWith(item))) {
    throw new HttpError(400, "reserved_table_prefix");
  }
  return prefix;
}

function migrationImpact(analyses: MigrationStatementAnalysis[]) {
  const data = analyses.filter((item) => item.category === "data");
  return {
    dataMutationTypes: Array.from(new Set(data.map((item) => item.type))).sort(),
    dataStatementCount: data.length,
    dataTables: Array.from(new Set(data.map((item) => item.table))).sort(),
    requiresDataMigrationApproval: data.length > 0,
    schemaStatementCount: analyses.length - data.length,
    statementCount: analyses.length,
    statementTypes: analyses.map((item) => item.type)
  };
}

async function sha256Hex(bytes: Uint8Array) {
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
