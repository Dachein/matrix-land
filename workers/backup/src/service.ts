import type {
  AppsBackupAppAdminItem,
  AppsBackupArtifact,
  AppsBackupJob,
  AppsBackupNode,
  AppsBackupPolicy
} from "../../../src/shared/types";
import { requireAdmin, requireAppAccess, requireAppOwner } from "./auth";
import { readJson } from "./http";
import { defaultBackupPolicy } from "./policy";
import { nextRunAt, normalizeComplianceRetention, normalizeSchedule } from "./schedule";
import type { AppSnapshot, Env, Principal } from "./types";
import { HttpError } from "./types";

export async function readAppBackup(env: Env, principal: Principal, appId: string) {
  const app = await requireAppAccess(env, principal, appId);
  const [policy, jobs] = await Promise.all([readPolicy(env.BACKUP_DB, appId), listJobs(env.BACKUP_DB, { appId, limit: 50 })]);
  return { policy: policy ?? defaultBackupPolicy(appId), resourceTypes: resourceTypes(app), jobs };
}

export async function updateAppBackup(request: Request, env: Env, principal: Principal, appId: string) {
  const app = await requireAppAccess(env, principal, appId);
  requireAppOwner(principal, app);
  if (app.resources.length === 0) throw new HttpError(409, "backup_resources_not_enabled");
  const body = await readJson<Partial<AppsBackupPolicy>>(request);
  const schedule = normalizeSchedule(body);
  const complianceRetention = normalizeComplianceRetention(body);
  const enabled = body.enabled === true;
  const now = new Date();
  const existing = await env.BACKUP_DB.prepare("SELECT * FROM app_backup_policies WHERE app_id = ?").bind(appId).first<Record<string, unknown>>();
  await env.BACKUP_DB.prepare(
    `INSERT INTO app_backup_policies (
      app_id, org_id, app_name, app_code, owner_user_id, resource_snapshot_json,
      enabled, frequency, schedule_time, schedule_timezone, schedule_weekday,
      schedule_monthday, compliance_retention_enabled, compliance_retention_years,
      backup_node_id, local_copy_limit,
      next_run_at, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10, ?, ?, ?, ?, ?)
    ON CONFLICT(app_id) DO UPDATE SET
      app_name = excluded.app_name, app_code = excluded.app_code,
      owner_user_id = excluded.owner_user_id, resource_snapshot_json = excluded.resource_snapshot_json,
      enabled = excluded.enabled, frequency = excluded.frequency,
      schedule_time = excluded.schedule_time, schedule_timezone = excluded.schedule_timezone,
      schedule_weekday = excluded.schedule_weekday, schedule_monthday = excluded.schedule_monthday,
      compliance_retention_enabled = excluded.compliance_retention_enabled,
      compliance_retention_years = excluded.compliance_retention_years,
      next_run_at = excluded.next_run_at,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(
    app.id, app.orgId, app.name, app.code, app.ownerUserId, JSON.stringify(app.resources),
    enabled ? 1 : 0, schedule.frequency, schedule.scheduleTime, schedule.scheduleTimezone,
    schedule.scheduleWeekday, schedule.scheduleMonthday,
    complianceRetention.complianceRetentionEnabled ? 1 : 0,
    complianceRetention.complianceRetentionYears,
    text(existing?.backup_node_id) || null, enabled ? nextRunAt(schedule, now) : null,
    text(existing?.created_by) || principal.sub, principal.sub, text(existing?.created_at) || now.toISOString(), now.toISOString()
  ).run();
  await audit(env, principal, enabled ? "enabled app backup" : "disabled app backup", "app", appId, {
    frequency: schedule.frequency,
    complianceRetentionEnabled: complianceRetention.complianceRetentionEnabled,
    complianceRetentionYears: complianceRetention.complianceRetentionYears
  });
  return readAppBackup(env, principal, appId);
}

export async function listArtifacts(env: Env, principal: Principal, appId: string, jobId: string) {
  await requireAppAccess(env, principal, appId);
  const result = await env.BACKUP_DB.prepare("SELECT * FROM backup_artifacts WHERE app_id = ? AND job_id = ? ORDER BY kind, source_key").bind(appId, jobId).all<Record<string, unknown>>();
  return { artifacts: (result.results ?? []).map(artifactFromRow) };
}

export async function downloadArtifact(env: Env, principal: Principal, appId: string, jobId: string, artifactId: string) {
  await requireAppAccess(env, principal, appId);
  const row = await env.BACKUP_DB.prepare("SELECT * FROM backup_artifacts WHERE id = ? AND app_id = ? AND job_id = ?").bind(artifactId, appId, jobId).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "backup_artifact_not_found");
  const object = await env.BACKUP_ARCHIVES.get(text(row.artifact_key));
  if (!object) throw new HttpError(404, "backup_artifact_expired");
  await audit(env, principal, "downloaded backup artifact", "backup_job", jobId, { artifactId, appId });
  const filename = artifactFilename(row);
  return new Response(object.body, { headers: {
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": String(object.size),
    "Content-Type": text(row.content_type) || object.httpMetadata?.contentType || "application/octet-stream"
  }});
}

export async function downloadJobArchive(env: Env, principal: Principal, appId: string, jobId: string) {
  await requireAppAccess(env, principal, appId);
  const row = await env.BACKUP_DB.prepare(
    "SELECT * FROM backup_artifacts WHERE app_id = ? AND job_id = ? AND kind = 'archive' ORDER BY created_at DESC LIMIT 1"
  ).bind(appId, jobId).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "backup_archive_not_found");
  const object = await env.BACKUP_ARCHIVES.get(text(row.artifact_key));
  if (!object) throw new HttpError(404, "backup_artifact_expired");
  await audit(env, principal, "downloaded backup ZIP", "backup_job", jobId, { artifactId: text(row.id), appId });
  return new Response(object.body, { headers: {
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${artifactFilename(row)}"`,
    "Content-Length": String(object.size),
    "Content-Type": "application/zip"
  }});
}

export async function listAdminApps(env: Env, principal: Principal) {
  requireAdmin(principal);
  const result = await env.BACKUP_DB.prepare(
    `SELECT p.*, n.name AS backup_node_name FROM app_backup_policies p
     LEFT JOIN backup_nodes n ON n.id = p.backup_node_id
     WHERE p.org_id = ? AND p.enabled = 1 ORDER BY p.app_name`
  ).bind(principal.orgId).all<Record<string, unknown>>();
  const apps: AppsBackupAppAdminItem[] = [];
  for (const row of result.results ?? []) {
    const jobs = await listJobs(env.BACKUP_DB, { appId: text(row.app_id), limit: 1 });
    apps.push({
      appId: text(row.app_id), appName: text(row.app_name), appCode: text(row.app_code),
      orgId: text(row.org_id), ownerUserId: text(row.owner_user_id),
      resourceTypes: resourceTypesFromJson(row.resource_snapshot_json), policy: policyFromRow(row), lastJob: jobs[0]
    });
  }
  return { apps };
}

export async function listAdminJobs(env: Env, principal: Principal) {
  requireAdmin(principal);
  return { jobs: await listJobs(env.BACKUP_DB, { orgId: principal.orgId, limit: 200 }) };
}

export async function listNodes(env: Env, principal: Principal) {
  requireAdmin(principal);
  const result = await env.BACKUP_DB.prepare("SELECT * FROM backup_nodes WHERE org_id = ? ORDER BY is_default DESC, name").bind(principal.orgId).all<Record<string, unknown>>();
  return { nodes: (result.results ?? []).map(nodeFromRow) };
}

export async function createNode(request: Request, env: Env, principal: Principal) {
  requireAdmin(principal);
  const body = await readJson<Record<string, unknown>>(request);
  const id = `bnode_${randomId()}`;
  const now = new Date().toISOString();
  const password = required(body.password, "missing_backup_node_password", 4096);
  const encrypted = await encrypt(password, env);
  const isDefault = body.isDefault === true;
  const statements: D1PreparedStatement[] = [];
  if (isDefault) statements.push(env.BACKUP_DB.prepare("UPDATE backup_nodes SET is_default = 0, updated_at = ?, updated_by = ? WHERE org_id = ?").bind(now, principal.sub, principal.orgId));
  statements.push(env.BACKUP_DB.prepare(
    `INSERT INTO backup_nodes (id, org_id, name, protocol, host, port, username, remote_path,
      host_key_fingerprint, password_cipher_text, password_cipher_iv, password_algorithm,
      is_default, status, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, 'sftp', ?, ?, ?, ?, ?, ?, ?, 'AES-GCM', ?, 'active', ?, ?, ?, ?)`
  ).bind(id, principal.orgId, required(body.name, "missing_backup_node_name", 120), host(body.host), port(body.port),
    required(body.username, "missing_backup_node_username", 160), remotePath(body.remotePath), text(body.hostKeyFingerprint),
    encrypted.cipherText, encrypted.cipherIv, isDefault ? 1 : 0, principal.sub, principal.sub, now, now));
  await env.BACKUP_DB.batch(statements);
  await audit(env, principal, "created backup node", "backup_node", id, {});
  return { node: await getNode(env, principal, id) };
}

export async function updateNode(request: Request, env: Env, principal: Principal, nodeId: string) {
  requireAdmin(principal);
  const current = await requireNodeRow(env, principal, nodeId);
  const body = await readJson<Record<string, unknown>>(request);
  const password = text(body.password);
  const encrypted = password ? await encrypt(password, env) : undefined;
  const now = new Date().toISOString();
  const isDefault = body.isDefault === undefined ? number(current.is_default) === 1 : body.isDefault === true;
  const statements: D1PreparedStatement[] = [];
  if (isDefault) statements.push(env.BACKUP_DB.prepare("UPDATE backup_nodes SET is_default = 0 WHERE org_id = ? AND id <> ?").bind(principal.orgId, nodeId));
  statements.push(env.BACKUP_DB.prepare(
    `UPDATE backup_nodes SET name = ?, host = ?, port = ?, username = ?, remote_path = ?,
      host_key_fingerprint = ?, password_cipher_text = ?, password_cipher_iv = ?, is_default = ?,
      status = ?, updated_by = ?, updated_at = ? WHERE id = ? AND org_id = ?`
  ).bind(
    body.name === undefined ? text(current.name) : required(body.name, "missing_backup_node_name", 120),
    body.host === undefined ? text(current.host) : host(body.host), body.port === undefined ? number(current.port) : port(body.port),
    body.username === undefined ? text(current.username) : required(body.username, "missing_backup_node_username", 160),
    body.remotePath === undefined ? text(current.remote_path) : remotePath(body.remotePath),
    body.hostKeyFingerprint === undefined ? text(current.host_key_fingerprint) : text(body.hostKeyFingerprint),
    encrypted?.cipherText ?? current.password_cipher_text ?? null, encrypted?.cipherIv ?? current.password_cipher_iv ?? null,
    isDefault ? 1 : 0, body.status === "disabled" ? "disabled" : "active", principal.sub, now, nodeId, principal.orgId
  ));
  await env.BACKUP_DB.batch(statements);
  await audit(env, principal, "updated backup node", "backup_node", nodeId, {});
  return { node: await getNode(env, principal, nodeId) };
}

export async function assignNode(request: Request, env: Env, principal: Principal, appId: string) {
  requireAdmin(principal);
  const body = await readJson<{ nodeId?: string }>(request);
  const nodeId = text(body.nodeId);
  if (nodeId) {
    const node = await requireNodeRow(env, principal, nodeId);
    if (text(node.status) !== "active") throw new HttpError(409, "backup_node_disabled");
  }
  const now = new Date().toISOString();
  const result = await env.BACKUP_DB.prepare("UPDATE app_backup_policies SET backup_node_id = ?, updated_by = ?, updated_at = ? WHERE app_id = ? AND org_id = ? AND enabled = 1")
    .bind(nodeId || null, principal.sub, now, appId, principal.orgId).run();
  if (!result.meta.changes) throw new HttpError(404, "backup_policy_not_found");
  if (nodeId) {
    await env.BACKUP_DB.batch([
      env.BACKUP_DB.prepare(
        `UPDATE backup_deliveries SET backup_node_id = ?, status = 'pending_agent', updated_at = ?
         WHERE status = 'waiting_for_node' AND job_id IN (SELECT id FROM backup_jobs WHERE app_id = ? AND retained = 1)`
      ).bind(nodeId, now, appId),
      env.BACKUP_DB.prepare(
        `UPDATE backup_jobs SET backup_node_id = ?, status = 'succeeded',
          current_step = 'Cloudflare backup complete; awaiting transfer agent', updated_at = ?
         WHERE app_id = ? AND status = 'waiting_for_node' AND retained = 1`
      ).bind(nodeId, now, appId)
    ]);
  }
  await audit(env, principal, "assigned backup node", "app", appId, { nodeId: nodeId || null });
  return { policy: await readPolicy(env.BACKUP_DB, appId) };
}

export async function testNode(env: Env, principal: Principal, nodeId: string) {
  requireAdmin(principal);
  const node = await requireNodeRow(env, principal, nodeId);
  const started = Date.now();
  let status: "reachable" | "unreachable" = "unreachable";
  let error = "";
  try {
    const { connect } = await import("cloudflare:sockets");
    const socket = connect({ hostname: text(node.host), port: number(node.port) });
    await timeout(socket.opened, 8_000);
    socket.close();
    status = "reachable";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "backup_node_unreachable";
  }
  const latencyMs = Date.now() - started;
  const now = new Date().toISOString();
  await env.BACKUP_DB.prepare("UPDATE backup_nodes SET last_test_status = ?, last_test_latency_ms = ?, last_test_error = ?, last_tested_at = ?, updated_at = ?, updated_by = ? WHERE id = ?")
    .bind(status, latencyMs, error || null, now, now, principal.sub, nodeId).run();
  await audit(env, principal, "tested backup node", "backup_node", nodeId, { latencyMs, status });
  return { node: await getNode(env, principal, nodeId), test: { status, latencyMs, error: error || undefined, verificationLevel: "tcp", testedAt: now } };
}

export async function readPolicy(db: D1Database, appId: string): Promise<AppsBackupPolicy | undefined> {
  const row = await db.prepare("SELECT p.*, n.name AS backup_node_name FROM app_backup_policies p LEFT JOIN backup_nodes n ON n.id = p.backup_node_id WHERE p.app_id = ?").bind(appId).first<Record<string, unknown>>();
  return row ? policyFromRow(row) : undefined;
}

export async function listJobs(db: D1Database, filter: { appId?: string; orgId?: string; limit: number }): Promise<AppsBackupJob[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.appId) { conditions.push("j.app_id = ?"); values.push(filter.appId); }
  if (filter.orgId) { conditions.push("j.org_id = ?"); values.push(filter.orgId); }
  const result = await db.prepare(
    `SELECT j.*, n.name AS backup_node_name, d.status AS delivery_status,
       EXISTS (SELECT 1 FROM backup_artifacts a WHERE a.job_id = j.id AND a.kind = 'archive') AS archive_available
     FROM backup_jobs j
     LEFT JOIN backup_nodes n ON n.id = j.backup_node_id LEFT JOIN backup_deliveries d ON d.job_id = j.id
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY j.created_at DESC LIMIT ?`
  ).bind(...values, Math.min(Math.max(filter.limit, 1), 500)).all<Record<string, unknown>>();
  return (result.results ?? []).map(jobFromRow);
}

export async function audit(env: Env, principal: Principal, action: string, targetType: string, targetId: string, metadata: unknown) {
  await env.BACKUP_DB.prepare("INSERT INTO backup_audit_logs (id, actor_user_id, org_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(`audit_${randomId()}`, principal.sub, principal.orgId, action, targetType, targetId, JSON.stringify(metadata ?? {}), new Date().toISOString()).run();
}

function policyFromRow(row: Record<string, unknown>): AppsBackupPolicy {
  return { appId: text(row.app_id), enabled: number(row.enabled) === 1, frequency: text(row.frequency) as AppsBackupPolicy["frequency"], scheduleTime: text(row.schedule_time), scheduleTimezone: "Asia/Hong_Kong", scheduleWeekday: number(row.schedule_weekday), scheduleMonthday: number(row.schedule_monthday), complianceRetentionEnabled: number(row.compliance_retention_enabled) === 1, complianceRetentionYears: boundedInteger(row.compliance_retention_years, 1, 99, 7), backupNodeId: text(row.backup_node_id) || undefined, backupNodeName: text(row.backup_node_name) || undefined, localCopyLimit: 10, nextRunAt: text(row.next_run_at) || undefined, lastRunAt: text(row.last_run_at) || undefined, createdAt: text(row.created_at) || undefined, updatedAt: text(row.updated_at) || undefined };
}

function nodeFromRow(row: Record<string, unknown>): AppsBackupNode {
  return { id: text(row.id), orgId: text(row.org_id), name: text(row.name), protocol: "sftp", host: text(row.host), port: number(row.port), username: text(row.username), remotePath: text(row.remote_path), hostKeyFingerprint: text(row.host_key_fingerprint) || undefined, passwordConfigured: Boolean(row.password_cipher_text), isDefault: number(row.is_default) === 1, status: text(row.status) === "disabled" ? "disabled" : "active", lastTestStatus: text(row.last_test_status) as AppsBackupNode["lastTestStatus"] || undefined, lastTestLatencyMs: row.last_test_latency_ms == null ? undefined : number(row.last_test_latency_ms), lastTestError: text(row.last_test_error) || undefined, lastTestedAt: text(row.last_tested_at) || undefined, createdAt: text(row.created_at), updatedAt: text(row.updated_at) };
}

function jobFromRow(row: Record<string, unknown>): AppsBackupJob {
  return { id: text(row.id), appId: text(row.app_id), appName: text(row.app_name), appCode: text(row.app_code), orgId: text(row.org_id), backupNodeId: text(row.backup_node_id) || undefined, backupNodeName: text(row.backup_node_name) || undefined, triggerType: text(row.trigger_type) === "manual" ? "manual" : "scheduled", status: text(row.status) as AppsBackupJob["status"], sourceTypes: parseArray(row.source_types_json).filter((value): value is "d1" | "r2" => value === "d1" || value === "r2"), artifactPrefix: text(row.artifact_prefix), manifestKey: text(row.manifest_key) || undefined, objectCount: number(row.object_count), totalBytes: number(row.total_bytes), archiveAvailable: number(row.archive_available) === 1, retained: number(row.retained) === 1, complianceRetentionEnabled: number(row.compliance_retention_enabled) === 1, complianceRetentionYears: boundedInteger(row.compliance_retention_years, 1, 99, 7), retainUntil: text(row.retain_until) || undefined, currentStep: text(row.current_step) || undefined, errorCode: text(row.error_code) || undefined, errorMessage: text(row.error_message) || undefined, requestedBy: text(row.requested_by), deliveryStatus: text(row.delivery_status) as AppsBackupJob["deliveryStatus"] || undefined, createdAt: text(row.created_at), updatedAt: text(row.updated_at), startedAt: text(row.started_at) || undefined, completedAt: text(row.completed_at) || undefined };
}

function artifactFromRow(row: Record<string, unknown>): AppsBackupArtifact {
  return { id: text(row.id), jobId: text(row.job_id), appId: text(row.app_id), kind: text(row.kind) as AppsBackupArtifact["kind"], sourceResourceId: text(row.source_resource_id) || undefined, sourceKey: text(row.source_key) || undefined, artifactKey: text(row.artifact_key), contentType: text(row.content_type), sizeBytes: number(row.size_bytes), checksum: text(row.checksum) || undefined, createdAt: text(row.created_at) };
}

function resourceTypes(app: AppSnapshot) { return Array.from(new Set(app.resources.map((resource) => resource.type === "d1_database" ? "d1" as const : "r2" as const))); }
function resourceTypesFromJson(value: unknown) { return Array.from(new Set(parseObjects(value).map((resource) => text(resource.type) === "d1_database" ? "d1" as const : "r2" as const))); }
async function getNode(env: Env, principal: Principal, id: string) { return nodeFromRow(await requireNodeRow(env, principal, id)); }
async function requireNodeRow(env: Env, principal: Principal, id: string) { const row = await env.BACKUP_DB.prepare("SELECT * FROM backup_nodes WHERE id = ? AND org_id = ?").bind(id, principal.orgId).first<Record<string, unknown>>(); if (!row) throw new HttpError(404, "backup_node_not_found"); return row; }
function artifactFilename(row: Record<string, unknown>) { const raw = text(row.kind) === "manifest" ? "manifest.json" : text(row.kind) === "d1_export" ? `${text(row.source_resource_id) || "database"}.sql` : text(row.source_key).split("/").pop() || (text(row.kind) === "archive" ? "backup.zip" : "backup-file"); return raw.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 180); }
function host(value: unknown) { const result = required(value, "missing_backup_node_host", 253).toLowerCase(); if (result.includes("://") || result.includes("/") || /\s/.test(result)) throw new HttpError(400, "invalid_backup_node_host"); return result; }
function port(value: unknown) { const result = Number(value ?? 22); if (!Number.isInteger(result) || result < 1 || result > 65535) throw new HttpError(400, "invalid_backup_node_port"); return result; }
function remotePath(value: unknown) { const result = required(value || "/backups", "missing_backup_remote_path", 512); if (!result.startsWith("/") || result.includes("..")) throw new HttpError(400, "invalid_backup_remote_path"); return result.replace(/\/+$/, "") || "/"; }
function required(value: unknown, code: string, max: number) { const result = text(value); if (!result || result.length > max) throw new HttpError(400, code); return result; }
function text(value: unknown) { return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim(); }
function number(value: unknown) { return Number(value) || 0; }
function boundedInteger(value: unknown, min: number, max: number, fallback: number) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback; }
function parseArray(value: unknown): string[] { try { const parsed = JSON.parse(text(value)); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } }
function parseObjects(value: unknown): Array<Record<string, unknown>> { try { const parsed = JSON.parse(text(value)); return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>> : []; } catch { return []; } }
function randomId() { return crypto.randomUUID().replace(/-/g, ""); }
async function encrypt(value: string, env: Env) { const material = env.BACKUP_NODE_CREDENTIAL_ENCRYPTION_KEY?.trim(); if (!material) throw new HttpError(503, "backup_node_credential_encryption_not_configured"); const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)); const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]); const iv = crypto.getRandomValues(new Uint8Array(12)); const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value))); return { cipherText: btoa(String.fromCharCode(...cipher)), cipherIv: btoa(String.fromCharCode(...iv)) }; }
async function timeout<T>(promise: Promise<T>, ms: number) { let timer: ReturnType<typeof setTimeout>; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("backup_node_connect_timeout")), ms); })]); } finally { clearTimeout(timer!); } }
