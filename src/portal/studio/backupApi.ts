import type { AppsBackupAppAdminItem, AppsBackupArtifact, AppsBackupJob, AppsBackupNode, AppsBackupPolicy } from "../../shared/types";

export type AppBackupPayload = { policy: AppsBackupPolicy; resourceTypes: Array<"d1" | "r2">; jobs: AppsBackupJob[] };
export type AdminBackupPayload = { apps: AppsBackupAppAdminItem[]; jobs: AppsBackupJob[]; nodes: AppsBackupNode[] };

export async function getAppBackup(appId: string) { return request<AppBackupPayload>(`/apps/${encodeURIComponent(appId)}/backup`); }
export async function saveAppBackup(appId: string, input: Partial<AppsBackupPolicy>) { return request<AppBackupPayload>(`/apps/${encodeURIComponent(appId)}/backup`, { method: "PUT", body: JSON.stringify(input) }); }
export async function runAppBackupNow(appId: string) { return request<{ jobId: string }>(`/apps/${encodeURIComponent(appId)}/backups/run`, { method: "POST" }); }
export async function getBackupArtifacts(appId: string, jobId: string) { return request<{ artifacts: AppsBackupArtifact[] }>(`/apps/${encodeURIComponent(appId)}/backups/${encodeURIComponent(jobId)}/artifacts`); }
export function backupArtifactDownloadUrl(appId: string, jobId: string, artifactId: string) { return `/api/backups/apps/${encodeURIComponent(appId)}/backups/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}/download`; }
export function backupJobDownloadUrl(appId: string, jobId: string) { return `/api/backups/apps/${encodeURIComponent(appId)}/backups/${encodeURIComponent(jobId)}/download`; }
export async function getAdminBackups(): Promise<AdminBackupPayload> { const [apps, jobs, nodes] = await Promise.all([request<{ apps: AppsBackupAppAdminItem[] }>("/admin/apps"), request<{ jobs: AppsBackupJob[] }>("/admin/jobs"), request<{ nodes: AppsBackupNode[] }>("/admin/nodes")]); return { ...apps, ...jobs, ...nodes }; }
export async function createBackupNode(input: Record<string, unknown>) { return request<{ node: AppsBackupNode }>("/admin/nodes", { method: "POST", body: JSON.stringify(input) }); }
export async function testBackupNode(nodeId: string) { return request<{ node: AppsBackupNode; test: { status: string; latencyMs: number; verificationLevel: "tcp"; error?: string } }>(`/admin/nodes/${encodeURIComponent(nodeId)}/test`, { method: "POST" }); }
export async function assignBackupNode(appId: string, nodeId?: string) { return request<{ policy: AppsBackupPolicy }>(`/admin/apps/${encodeURIComponent(appId)}/node`, { method: "PATCH", body: JSON.stringify({ nodeId }) }); }
export async function runBackupNow(appId: string) { return request<{ jobId: string }>(`/admin/apps/${encodeURIComponent(appId)}/run`, { method: "POST" }); }
export async function retryBackup(jobId: string) { return request<{ jobId: string }>(`/admin/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" }); }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/backups${path}`, { ...init, headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `backup_request_failed_${response.status}`);
  return payload;
}
