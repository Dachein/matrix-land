import { readJson } from "./http.ts";
import type { Env } from "./types.ts";
import { HttpError } from "./types.ts";
import { enforceRetentionForApp } from "./executor.ts";

export async function requireTransferAgent(request: Request, env: Env) {
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const expected = env.BACKUP_TRANSFER_AGENT_TOKEN?.trim() ?? "";
  if (!expected) throw new HttpError(503, "backup_transfer_agent_token_not_configured");
  if (!supplied || !(await equal(supplied, expected))) throw new HttpError(401, "invalid_backup_transfer_agent_token");
}

export async function claimNextDelivery(env: Env) {
  const now = new Date().toISOString();
  const delivery = await env.BACKUP_DB.prepare(
    `UPDATE backup_deliveries SET status = 'uploading', started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE id = (SELECT id FROM backup_deliveries WHERE status = 'pending_agent' ORDER BY created_at LIMIT 1)
     AND status = 'pending_agent' RETURNING *`
  ).bind(now, now).first<Record<string, unknown>>();
  if (!delivery) return { delivery: null };
  const job = await env.BACKUP_DB.prepare("SELECT * FROM backup_jobs WHERE id = ?").bind(text(delivery.job_id)).first<Record<string, unknown>>();
  const node = await env.BACKUP_DB.prepare("SELECT * FROM backup_nodes WHERE id = ? AND status = 'active'").bind(text(delivery.backup_node_id)).first<Record<string, unknown>>();
  if (!job || !node) {
    await env.BACKUP_DB.prepare("UPDATE backup_deliveries SET status = 'failed', error_code = 'delivery_configuration_missing', updated_at = ? WHERE id = ?").bind(now, text(delivery.id)).run();
    throw new HttpError(409, "delivery_configuration_missing");
  }
  const password = await decrypt(text(node.password_cipher_text), text(node.password_cipher_iv), env);
  const artifacts = await env.BACKUP_DB.prepare("SELECT id, kind, source_key, artifact_key, size_bytes, content_type FROM backup_artifacts WHERE job_id = ? ORDER BY kind, artifact_key")
    .bind(text(job.id)).all<Record<string, unknown>>();
  const remotePath = `${text(node.remote_path).replace(/\/$/, "")}/${safe(text(job.app_code))}/${text(job.id)}`;
  await env.BACKUP_DB.batch([
    env.BACKUP_DB.prepare("UPDATE backup_deliveries SET remote_path = ?, updated_at = ? WHERE id = ?").bind(remotePath, now, text(delivery.id)),
    env.BACKUP_DB.prepare("UPDATE backup_jobs SET current_step = 'Transfer Agent uploading to SFTP', updated_at = ? WHERE id = ?").bind(now, text(job.id))
  ]);
  return { delivery: {
    id: text(delivery.id), jobId: text(job.id), appId: text(job.app_id), appCode: text(job.app_code), remotePath,
    retention: {
      complianceEnabled: number(job.compliance_retention_enabled) === 1,
      minimumYears: boundedInteger(job.compliance_retention_years, 1, 99, 7),
      retainUntil: text(job.retain_until) || undefined
    },
    node: { protocol: "sftp", host: text(node.host), port: number(node.port), username: text(node.username), password, hostKeyFingerprint: text(node.host_key_fingerprint) || undefined },
    artifacts: (artifacts.results ?? []).map((artifact) => ({ id: text(artifact.id), kind: text(artifact.kind), sourceKey: text(artifact.source_key) || undefined, relativePath: text(artifact.artifact_key).slice(`${text(job.artifact_prefix)}/`.length), sizeBytes: number(artifact.size_bytes), contentType: text(artifact.content_type), downloadPath: `/agent/deliveries/${encodeURIComponent(text(delivery.id))}/artifacts/${encodeURIComponent(text(artifact.id))}` }))
  }};
}

export async function downloadAgentArtifact(env: Env, deliveryId: string, artifactId: string) {
  const artifact = await env.BACKUP_DB.prepare(
    `SELECT a.* FROM backup_artifacts a JOIN backup_deliveries d ON d.job_id = a.job_id
     WHERE d.id = ? AND a.id = ? AND d.status IN ('uploading', 'succeeded')`
  ).bind(deliveryId, artifactId).first<Record<string, unknown>>();
  if (!artifact) throw new HttpError(404, "backup_agent_artifact_not_found");
  const object = await env.BACKUP_ARCHIVES.get(text(artifact.artifact_key));
  if (!object) throw new HttpError(404, "backup_artifact_expired");
  return new Response(object.body, { headers: { "Content-Type": text(artifact.content_type) || "application/octet-stream", "Content-Length": String(object.size), "Cache-Control": "private, no-store" } });
}

export async function finishDelivery(request: Request, env: Env, deliveryId: string) {
  const body = await readJson<{ status?: string; bytesSent?: number; errorCode?: string; errorMessage?: string }>(request);
  const succeeded = body.status === "succeeded";
  if (!succeeded && body.status !== "failed") throw new HttpError(400, "invalid_delivery_status");
  const now = new Date().toISOString();
  const result = await env.BACKUP_DB.prepare(
    `UPDATE backup_deliveries SET status = ?, bytes_sent = ?, error_code = ?, error_message = ?,
      completed_at = ?, updated_at = ? WHERE id = ? AND status = 'uploading'`
  ).bind(succeeded ? "succeeded" : "failed", Math.max(0, Number(body.bytesSent) || 0), succeeded ? null : text(body.errorCode) || "sftp_delivery_failed", succeeded ? null : text(body.errorMessage).slice(0, 2000), now, now, deliveryId).run();
  if (!result.meta.changes) throw new HttpError(409, "delivery_not_uploading");
  const delivery = await env.BACKUP_DB.prepare("SELECT job_id FROM backup_deliveries WHERE id = ?").bind(deliveryId).first<Record<string, unknown>>();
  const job = await env.BACKUP_DB.prepare("SELECT app_id FROM backup_jobs WHERE id = ?").bind(text(delivery?.job_id)).first<Record<string, unknown>>();
  await env.BACKUP_DB.prepare("UPDATE backup_jobs SET current_step = ?, updated_at = ? WHERE id = ?")
    .bind(succeeded ? "Cloudflare backup complete; SFTP delivery verified" : "Cloudflare backup complete; SFTP delivery failed", now, text(delivery?.job_id)).run();
  if (succeeded && job) await enforceRetentionForApp(env, text(job.app_id));
  return { deliveryId, status: succeeded ? "succeeded" : "failed", completedAt: now };
}

async function decrypt(cipherText: string, cipherIv: string, env: Env) {
  const material = env.BACKUP_NODE_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!material || !cipherText || !cipherIv) throw new HttpError(503, "backup_node_credentials_unavailable");
  try {
    const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64(cipherIv) }, key, base64(cipherText));
    return new TextDecoder().decode(plain);
  } catch { throw new HttpError(503, "backup_node_credentials_invalid"); }
}
async function equal(left: string, right: string) { const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)), crypto.subtle.digest("SHA-256", new TextEncoder().encode(right))]); return a.byteLength === b.byteLength && new Uint8Array(a).every((value, index) => value === new Uint8Array(b)[index]); }
function base64(value: string) { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function text(value: unknown) { return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim(); }
function number(value: unknown) { return Number(value) || 0; }
function boundedInteger(value: unknown, min: number, max: number, fallback: number) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback; }
function safe(value: string) { return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 100) || "app"; }
