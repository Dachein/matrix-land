import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client } from "ssh2";

const workerUrl = required("BACKUP_WORKER_URL").replace(/\/$/, "");
const agentToken = required("BACKUP_TRANSFER_AGENT_TOKEN");
const pollMs = boundedNumber(process.env.POLL_INTERVAL_MS, 15_000, 1_000, 60_000);
let lastRunAt = "";
let lastError = "";
let activeDeliveryId = "";

createServer((_request, response) => {
  response.writeHead(lastError ? 503 : 200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ ok: !lastError, service: "workspace-backup-transfer-agent", activeDeliveryId: activeDeliveryId || undefined, lastRunAt, lastError: lastError || undefined }));
}).listen(boundedNumber(process.env.PORT, 8080, 1, 65535));

void runLoop();

async function runLoop() {
  for (;;) {
    try {
      const payload = await agentRequest("/agent/deliveries/next", { method: "POST" });
      if (payload.delivery) await deliver(payload.delivery);
      lastError = "";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error("backup_transfer_failed", { error: lastError, deliveryId: activeDeliveryId || undefined });
    } finally {
      activeDeliveryId = "";
      lastRunAt = new Date().toISOString();
    }
    await delay(pollMs);
  }
}

async function deliver(delivery) {
  activeDeliveryId = String(delivery.id);
  let bytesSent = 0;
  let client;
  try {
    client = await connectSftp(delivery.node);
    const sftp = await openSftp(client);
    for (const artifact of delivery.artifacts) {
      const relativePath = safeRelativePath(artifact.relativePath);
      const remoteFile = posix.join(delivery.remotePath, relativePath);
      await mkdirRecursive(sftp, posix.dirname(remoteFile));
      const response = await fetch(`${workerUrl}${artifact.downloadPath}`, { headers: authorization() });
      if (!response.ok || !response.body) throw new Error(`artifact_download_failed:${response.status}:${artifact.id}`);
      await pipeline(Readable.fromWeb(response.body), sftp.createWriteStream(remoteFile, { flags: "w", mode: 0o600 }));
      const stat = await sftpStat(sftp, remoteFile);
      if (Number(stat.size) !== Number(artifact.sizeBytes)) throw new Error(`remote_size_mismatch:${artifact.id}`);
      bytesSent += Number(stat.size);
    }
    await finish(activeDeliveryId, { status: "succeeded", bytesSent });
  } catch (error) {
    await finish(activeDeliveryId, { status: "failed", bytesSent, errorCode: "sftp_delivery_failed", errorMessage: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    throw error;
  } finally {
    client?.end();
  }
}

function connectSftp(node) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const expected = String(node.hostKeyFingerprint || "").trim();
    if (!expected) return reject(new Error("host_key_fingerprint_required"));
    client.once("ready", () => resolve(client)).once("error", reject).connect({
      host: node.host, port: Number(node.port), username: node.username, password: node.password,
      readyTimeout: 20_000,
      hostVerifier: (key) => fingerprint(key) === normalizeFingerprint(expected)
    });
  });
}
function openSftp(client) { return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp))); }
function sftpStat(sftp, path) { return new Promise((resolve, reject) => sftp.stat(path, (error, stats) => error ? reject(error) : resolve(stats))); }
async function mkdirRecursive(sftp, directory) { const parts = directory.split("/").filter(Boolean); let current = ""; for (const part of parts) { current += `/${part}`; const exists = await new Promise((resolve, reject) => sftp.stat(current, (error, stats) => error?.code === 2 ? resolve(false) : error ? reject(error) : stats.isDirectory() ? resolve(true) : reject(new Error(`remote_path_not_directory:${current}`)))); if (!exists) await new Promise((resolve, reject) => sftp.mkdir(current, { mode: 0o700 }, (error) => error ? reject(error) : resolve())); } }
function fingerprint(key) { return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`; }
function normalizeFingerprint(value) { return value.startsWith("SHA256:") ? value.replace(/=+$/, "") : `SHA256:${value.replace(/=+$/, "")}`; }
function safeRelativePath(value) { const normalized = posix.normalize(`/${String(value || "artifact")}`).slice(1); if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) throw new Error("invalid_artifact_path"); return normalized; }
function authorization() { return { Authorization: `Bearer ${agentToken}` }; }
async function finish(id, body) { return agentRequest(`/agent/deliveries/${encodeURIComponent(id)}/complete`, { method: "POST", body: JSON.stringify(body) }); }
async function agentRequest(path, init = {}) { const headers = { ...authorization(), Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) }; const response = await fetch(`${workerUrl}${path}`, { ...init, headers }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error || `backup_agent_request_failed:${response.status}`); return payload; }
function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function boundedNumber(value, fallback, min, max) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
