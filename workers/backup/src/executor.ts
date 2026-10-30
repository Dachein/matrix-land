import type { AppResourceSnapshot, BackupWorkflowParams, Env, Principal } from "./types";
import { HttpError } from "./types";
import { nextRunAt } from "./schedule";
import { readPolicy } from "./service";
import { requireAppAccess, requireAppOwner } from "./auth";
import { resolvePolicyForTrigger } from "./policy";
import { BACKUP_JOB_INSERT_SQL } from "./statements";
import { readD1ExportState } from "./cloudflare";
import {
  BackupZipArchive,
  backupArchiveFilename,
  d1ArchivePath,
  r2ArchivePath,
  type BackupArchiveEntry
} from "./archive";

type JobRow = Record<string, unknown>;

export async function createBackupJob(
  env: Env,
  principal: Principal,
  appId: string,
  triggerType: "manual" | "scheduled"
) {
  const app = await requireAppAccess(env, principal, appId);
  const storedPolicy = await env.BACKUP_DB.prepare("SELECT * FROM app_backup_policies WHERE app_id = ? AND org_id = ?")
    .bind(appId, principal.orgId).first<JobRow>();
  const policy = resolvePolicyForTrigger(storedPolicy, triggerType, app.orgId);
  if (!policy) throw new HttpError(404, "backup_policy_not_found");
  const resources = app.resources.filter((resource) => resource.status === "ready" || resource.status === "provisioned");
  if (!resources.length) throw new HttpError(409, "backup_resources_not_enabled");
  await env.BACKUP_DB.prepare("UPDATE app_backup_policies SET app_name = ?, app_code = ?, owner_user_id = ?, resource_snapshot_json = ?, updated_at = ? WHERE app_id = ?")
    .bind(app.name, app.code, app.ownerUserId, JSON.stringify(resources), new Date().toISOString(), appId).run();

  const id = `bjob_${randomId()}`;
  const createdAt = new Date().toISOString();
  const complianceRetentionEnabled = number(policy.compliance_retention_enabled) === 1;
  const complianceRetentionYears = boundedInteger(policy.compliance_retention_years, 1, 99, 7);
  const retainUntil = complianceRetentionEnabled ? retentionDeadline(createdAt, complianceRetentionYears) : null;
  const artifactPrefix = `${text(policy.org_id)}/${appId}/${createdAt.slice(0, 10)}/${id}`;
  const sourceTypes = Array.from(new Set(resources.map((resource) => resource.type === "d1_database" ? "d1" : "r2")));
  await env.BACKUP_DB.batch([
    env.BACKUP_DB.prepare(BACKUP_JOB_INSERT_SQL).bind(id, appId, app.name, app.code, text(policy.org_id), text(policy.backup_node_id) || null,
      triggerType, JSON.stringify(sourceTypes), JSON.stringify(resources), artifactPrefix,
      complianceRetentionEnabled ? 1 : 0, complianceRetentionYears, retainUntil,
      principal.sub, createdAt, createdAt),
    env.BACKUP_DB.prepare(
      `INSERT INTO backup_deliveries (id, job_id, backup_node_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(`bdel_${randomId()}`, id, text(policy.backup_node_id) || null,
      text(policy.backup_node_id) ? "pending_agent" : "waiting_for_node", createdAt, createdAt)
  ]);
  await env.BACKUP_WORKFLOW.create({ id, params: { jobId: id } satisfies BackupWorkflowParams });
  return { jobId: id };
}

export async function createAppManualBackupJob(env: Env, principal: Principal, appId: string) {
  const app = await requireAppAccess(env, principal, appId);
  requireAppOwner(principal, app);
  return createBackupJob(env, principal, appId, "manual");
}

export async function runDueBackups(env: Env, now = new Date()) {
  const due = await env.BACKUP_DB.prepare(
    "SELECT * FROM app_backup_policies WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 100"
  ).bind(now.toISOString()).all<JobRow>();
  let queued = 0;
  for (const policy of due.results ?? []) {
    const principal: Principal = { sub: "backup-scheduler", orgId: text(policy.org_id), role: "admin" };
    try {
      await createBackupJob(env, principal, text(policy.app_id), "scheduled");
      queued += 1;
      const schedule = {
        frequency: text(policy.frequency) as "daily" | "weekly" | "monthly",
        scheduleTime: text(policy.schedule_time), scheduleTimezone: "Asia/Hong_Kong",
        scheduleWeekday: number(policy.schedule_weekday), scheduleMonthday: number(policy.schedule_monthday)
      };
      await env.BACKUP_DB.prepare("UPDATE app_backup_policies SET next_run_at = ?, updated_at = ? WHERE app_id = ?")
        .bind(nextRunAt(schedule, new Date(now.getTime() + 1_000)), now.toISOString(), text(policy.app_id)).run();
    } catch (error) {
      console.error("Failed to queue scheduled backup", text(policy.app_id), error);
    }
  }
  return queued;
}

export async function executeBackupJob(env: Env, jobId: string) {
  const job = await requireJob(env, jobId);
  if (text(job.status) === "succeeded" || text(job.status) === "waiting_for_node") {
    return { jobId, cloudflareBackupComplete: true };
  }
  if (!env.CF_ACCOUNT_ID?.trim() || !env.BACKUP_CF_SOURCE_READ_TOKEN?.trim()) {
    throw await failJob(env, jobId, "cloudflare_api_not_configured", "CF_ACCOUNT_ID and BACKUP_CF_SOURCE_READ_TOKEN are required");
  }
  const resources = parseResources(job.resource_snapshot_json);
  const startedAt = new Date().toISOString();
  await resetJobArtifacts(env, job);
  await updateJob(env, jobId, { status: "exporting_d1", currentStep: "Exporting D1 databases", startedAt });
  let archive: BackupZipArchive | undefined;
  try {
    const filename = backupArchiveFilename(text(job.app_code), text(job.created_at), jobId);
    const key = `${text(job.artifact_prefix)}/${filename}`;
    archive = await BackupZipArchive.create(env.BACKUP_ARCHIVES, key, filename, new Date(text(job.created_at)));
    const entries: BackupArchiveEntry[] = [];
    for (const resource of resources.filter((item) => item.type === "d1_database")) {
      entries.push(await exportD1ToArchive(env, archive, resource));
    }
    await updateJob(env, jobId, { status: "copying_r2", currentStep: "Copying R2 objects" });
    for (const resource of resources.filter((item) => item.type === "r2_bucket")) {
      entries.push(...await copyR2ToArchive(env, archive, resource));
    }
    await updateJob(env, jobId, { status: "packaging", currentStep: "Compressing backup ZIP" });
    await writeManifestToArchive(env, archive, job, entries);
    const stored = await archive.finish();
    await insertArchiveArtifact(env, job, archive, stored.size, entries.length);
    const completedAt = new Date().toISOString();
    const nodeAssigned = Boolean(text(job.backup_node_id));
    await updateJob(env, jobId, {
      status: "succeeded",
      currentStep: nodeAssigned ? "Backup ZIP complete; awaiting transfer agent" : "Backup ZIP complete",
      completedAt
    });
    await env.BACKUP_DB.prepare("UPDATE app_backup_policies SET last_run_at = ?, updated_at = ? WHERE app_id = ?")
      .bind(completedAt, completedAt, text(job.app_id)).run();
    await enforceRetentionForApp(env, text(job.app_id));
    return { jobId, cloudflareBackupComplete: true, deliveryStatus: nodeAssigned ? "pending_agent" : "waiting_for_node" };
  } catch (error) {
    await archive?.abort().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    await failJob(env, jobId, "backup_execution_failed", message);
    throw error;
  }
}

async function exportD1ToArchive(env: Env, archive: BackupZipArchive, resource: AppResourceSnapshot): Promise<BackupArchiveEntry> {
  const base = cfApi(env, `/d1/database/${encodeURIComponent(resource.resourceId)}/export`);
  let body: Record<string, unknown> = { output_format: "polling" };
  let signedUrl = "";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = await cfRequest(env, base, { method: "POST", body: JSON.stringify(body) });
    const state = readD1ExportState(result);
    signedUrl = state.signedUrl;
    if (signedUrl) break;
    if (state.status === "error") throw new Error(state.error || "d1_export_failed");
    if (state.bookmark) body = { output_format: "polling", current_bookmark: state.bookmark };
    await delay(Math.min(1_000 + attempt * 250, 5_000));
  }
  if (!signedUrl) throw new Error(`d1_export_timeout:${resource.resourceName}`);
  const response = await fetch(signedUrl);
  if (!response.ok || !response.body) throw new Error(`d1_export_download_failed:${response.status}`);
  const archivePath = d1ArchivePath(resource.resourceName);
  const sizeBytes = await archive.addStream(archivePath, response.body);
  return { kind: "d1_export", sourceResourceId: resource.id, archivePath, contentType: "application/sql", sizeBytes };
}

async function copyR2ToArchive(env: Env, archive: BackupZipArchive, resource: AppResourceSnapshot) {
  const entries: BackupArchiveEntry[] = [];
  let cursor = "";
  do {
    const url = new URL(cfApi(env, `/r2/buckets/${encodeURIComponent(resource.resourceName)}/objects`));
    url.searchParams.set("per_page", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const list = await cfRequest(env, url.toString());
    const result = object(list.result);
    const objects = Array.isArray(result.objects) ? result.objects.map(object) : [];
    for (const source of objects) {
      const sourceKey = text(source.key || source.name);
      if (!sourceKey) continue;
      const response = await fetch(cfApi(env, `/r2/buckets/${encodeURIComponent(resource.resourceName)}/objects/${encodePath(sourceKey)}`), { headers: cfHeaders(env) });
      if (!response.ok || !response.body) throw new Error(`r2_object_download_failed:${response.status}:${sourceKey}`);
      const archivePath = r2ArchivePath(resource.resourceName, sourceKey);
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const sizeBytes = await archive.addStream(archivePath, response.body);
      entries.push({ kind: "r2_object", sourceResourceId: resource.id, sourceKey, archivePath, contentType, sizeBytes });
    }
    cursor = text(result.cursor);
  } while (cursor);
  return entries;
}

async function writeManifestToArchive(env: Env, archive: BackupZipArchive, job: JobRow, entries: BackupArchiveEntry[]) {
  const manifest = {
    version: 2,
    format: "workspace-backup-zip",
    jobId: text(job.id),
    appId: text(job.app_id),
    appCode: text(job.app_code),
    createdAt: text(job.created_at),
    archive: { filename: archive.filename },
    retention: {
      complianceEnabled: number(job.compliance_retention_enabled) === 1,
      minimumYears: boundedInteger(job.compliance_retention_years, 1, 99, 7),
      retainUntil: text(job.retain_until) || null,
      cloudflareQuickCopyLimit: localLimit(env)
    },
    resources: parseResources(job.resource_snapshot_json),
    entries
  };
  await archive.addText("manifest.json", JSON.stringify(manifest, null, 2));
}

async function insertArchiveArtifact(env: Env, job: JobRow, archive: BackupZipArchive, size: number, objectCount: number) {
  const now = new Date().toISOString();
  await env.BACKUP_DB.batch([
    env.BACKUP_DB.prepare(
      "INSERT INTO backup_artifacts (id, job_id, app_id, kind, source_key, artifact_key, content_type, size_bytes, created_at) VALUES (?, ?, ?, 'archive', ?, ?, 'application/zip', ?, ?)"
    ).bind(`bart_${randomId()}`, text(job.id), text(job.app_id), archive.filename, archive.key, size, now),
    env.BACKUP_DB.prepare("UPDATE backup_jobs SET object_count = ?, total_bytes = ?, manifest_key = ?, updated_at = ? WHERE id = ?")
      .bind(objectCount, size, archive.key, now, text(job.id))
  ]);
}

async function enforceRetention(env: Env, appId: string, limit: number) {
  const expired = await env.BACKUP_DB.prepare(
    `SELECT id, artifact_prefix FROM backup_jobs WHERE app_id = ? AND retained = 1
     AND status IN ('succeeded', 'waiting_for_node') ORDER BY created_at DESC LIMIT -1 OFFSET ?`
  ).bind(appId, limit).all<JobRow>();
  for (const job of expired.results ?? []) {
    let cursor: string | undefined;
    do {
      const listed = await env.BACKUP_ARCHIVES.list({ prefix: `${text(job.artifact_prefix)}/`, cursor });
      if (listed.objects.length) await env.BACKUP_ARCHIVES.delete(listed.objects.map((item) => item.key));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    await env.BACKUP_DB.prepare("UPDATE backup_jobs SET retained = 0, updated_at = ? WHERE id = ?").bind(new Date().toISOString(), text(job.id)).run();
  }
}

export function enforceRetentionForApp(env: Env, appId: string) {
  return enforceRetention(env, appId, localLimit(env));
}

async function requireJob(env: Env, jobId: string) {
  const row = await env.BACKUP_DB.prepare("SELECT * FROM backup_jobs WHERE id = ?").bind(jobId).first<JobRow>();
  if (!row) throw new HttpError(404, "backup_job_not_found");
  return row;
}

async function resetJobArtifacts(env: Env, job: JobRow) {
  let cursor: string | undefined;
  do {
    const listed = await env.BACKUP_ARCHIVES.list({ prefix: `${text(job.artifact_prefix)}/`, cursor });
    if (listed.objects.length) await env.BACKUP_ARCHIVES.delete(listed.objects.map((item) => item.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  await env.BACKUP_DB.batch([
    env.BACKUP_DB.prepare("DELETE FROM backup_artifacts WHERE job_id = ?").bind(text(job.id)),
    env.BACKUP_DB.prepare("UPDATE backup_jobs SET object_count = 0, total_bytes = 0, manifest_key = NULL, error_code = NULL, error_message = NULL WHERE id = ?").bind(text(job.id))
  ]);
}

async function updateJob(env: Env, jobId: string, fields: { status: string; currentStep: string; startedAt?: string; completedAt?: string }) {
  await env.BACKUP_DB.prepare("UPDATE backup_jobs SET status = ?, current_step = ?, started_at = COALESCE(started_at, ?), completed_at = COALESCE(?, completed_at), updated_at = ? WHERE id = ?")
    .bind(fields.status, fields.currentStep, fields.startedAt ?? null, fields.completedAt ?? null, new Date().toISOString(), jobId).run();
}

async function failJob(env: Env, jobId: string, code: string, message: string) {
  const now = new Date().toISOString();
  await env.BACKUP_DB.prepare("UPDATE backup_jobs SET status = 'failed', current_step = 'Backup failed', error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?")
    .bind(code, message.slice(0, 2000), now, now, jobId).run();
  return new Error(`${code}: ${message}`);
}

function cfApi(env: Env, suffix: string) { return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID!.trim())}${suffix}`; }
function cfHeaders(env: Env) { return { Authorization: `Bearer ${env.BACKUP_CF_SOURCE_READ_TOKEN!.trim()}` }; }
async function cfRequest(env: Env, url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${env.BACKUP_CF_SOURCE_READ_TOKEN!.trim()}`); headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const payload: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok || payload.success === false) throw new Error(`cloudflare_api_error:${response.status}:${JSON.stringify(payload.errors ?? payload)}`);
  return payload;
}
function parseResources(value: unknown): AppResourceSnapshot[] { try { const parsed = JSON.parse(text(value)); return Array.isArray(parsed) ? parsed.filter((item) => item && (item.type === "d1_database" || item.type === "r2_bucket")) as AppResourceSnapshot[] : []; } catch { return []; } }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function text(value: unknown) { return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim(); }
function number(value: unknown) { return Number(value) || 0; }
function boundedInteger(value: unknown, min: number, max: number, fallback: number) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback; }
function randomId() { return crypto.randomUUID().replace(/-/g, ""); }
function encodePath(value: string) { return value.split("/").map(encodeURIComponent).join("/"); }
function localLimit(env: Env) { const value = Number(env.BACKUP_LOCAL_COPY_LIMIT || 10); return Number.isInteger(value) && value > 0 ? Math.min(value, 100) : 10; }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function retentionDeadline(createdAt: string, years: number) { const value = new Date(createdAt); value.setUTCFullYear(value.getUTCFullYear() + years); return value.toISOString(); }

export async function retryBackupJob(env: Env, principal: Principal, jobId: string) {
  const job = await requireJob(env, jobId);
  if (text(job.org_id) !== principal.orgId) throw new HttpError(404, "backup_job_not_found");
  return createBackupJob(env, principal, text(job.app_id), "manual");
}

export async function getPolicyForJob(env: Env, jobId: string) {
  const job = await requireJob(env, jobId);
  return readPolicy(env.BACKUP_DB, text(job.app_id));
}
