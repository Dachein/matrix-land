import type { Env } from "../core/types";
import { HttpError } from "../core/types";
import type { AppsAppRow } from "../db/rows";
import { ensureManagedAppSecret } from "./appAuthSecrets";
import { configuredWorkerName } from "../../../../src/shared/requiredConfiguration";

export function workspaceStreamWorkerName(env: Env) {
  return configuredWorkerName(env.WORKSPACE_STREAM_WORKER_NAME, "WORKSPACE_STREAM_WORKER_NAME");
}
export const WORKSPACE_STREAM_BINDING = "WORKSPACE_STREAM";

/** Grants App-local access; no Cloudflare account credential reaches the App. */
export async function provisionAppStream(env: Env, app: AppsAppRow) {
  try {
    return await registerAppStream(env, app);
  } catch (error) {
    await env.APPS_DB.prepare("UPDATE apps_app_resources SET status = 'failed' WHERE app_id = ? AND type = 'media'").bind(app.id).run();
    throw error;
  }
}

async function registerAppStream(env: Env, app: AppsAppRow) {
  const worker = workspaceStreamWorkerName(env);
  if (!env.WORKSPACE_STREAM) throw new HttpError(503, "workspace_stream_service_not_configured");
  const health = await env.WORKSPACE_STREAM.fetch(new Request("https://workspace-stream.internal/health", { signal: AbortSignal.timeout(10_000) }));
  const status = await health.json() as { ok?: boolean; capabilities?: string[] };
  if (!health.ok || !status.ok || !status.capabilities?.includes("app-stream-v1")) {
    throw new HttpError(503, "workspace_stream_service_not_ready");
  }
  const token = await ensureManagedAppSecret(env, app, {
    name: "WORKSPACE_STREAM_TOKEN", description: "Platform-managed Stream credential restricted to this App",
    generateValue: () => `fstream_${[...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("")}`,
  });
  if (!/^fstream_[a-f0-9]{64}$/.test(token)) throw new HttpError(503, "managed_stream_credential_invalid");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map(b => b.toString(16).padStart(2, "0")).join("");
  const now = new Date().toISOString();
  await env.APPS_DB.prepare(`INSERT INTO apps_stream_app_grants (app_id, org_id, token_sha256, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(app_id) DO UPDATE SET org_id = excluded.org_id,
      token_sha256 = excluded.token_sha256, updated_at = excluded.updated_at`)
    .bind(app.id, app.org_id, hash, now, now).run();
  return { name: worker, provider: "workspace-stream", resourceId: `${worker}:${app.id}` };
}
