import type { PortalCatalog } from "../../../src/shared/types";
import { appsOrgContext } from "../appsProxy/context.ts";

type CurrentUser = PortalCatalog["currentUser"];
type BackupProxyEnv = {
  BACKUP_PORTAL_JWT_SECRET?: string;
  BACKUP_PROXY_TIMEOUT_MS?: string;
  BACKUP_WORKER_URL?: string;
  APPS_ORG_ID?: string;
  APPS_ORG_SLUG?: string;
  PORTAL_ISSUER?: string;
};
type BackupProxyContext<TEnv extends BackupProxyEnv> = EventContext<TEnv, string, unknown>;

export function createBackupProxyApi<TEnv extends BackupProxyEnv>(deps: {
  resolveCurrentUser(context: BackupProxyContext<TEnv>): Promise<CurrentUser>;
  signBackupToken(env: TEnv, payload: Record<string, unknown>): Promise<string>;
}) {
  return {
    async proxyBackupWorkerRequest(context: BackupProxyContext<TEnv>, path: string) {
      const currentUser = await deps.resolveCurrentUser(context);
      const upstreamPath = `/${path.replace(/^backups\/?/, "")}`.replace(/\/$/, "") || "/";
      if (upstreamPath.startsWith("/admin/") && currentUser.role !== "admin") {
        return jsonError("admin_required", 403);
      }
      const baseUrl = context.env.BACKUP_WORKER_URL?.trim();
      if (!baseUrl) return jsonError("backup_worker_url_not_configured", 503);
      const requestUrl = new URL(context.request.url);
      const upstreamUrl = new URL(upstreamPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
      upstreamUrl.search = requestUrl.search;
      const { orgId } = appsOrgContext(context.env, currentUser);
      const token = await deps.signBackupToken(context.env, {
        typ: "backup_access", iss: context.env.PORTAL_ISSUER ?? "frontier-workspace", sub: currentUser.id,
        org_id: orgId, platform_role: currentUser.role, email: currentUser.email,
        exp: Math.floor(Date.now() / 1000) + 600
      });
      const headers = new Headers({ Authorization: `Bearer ${token}`, "x-request-id": context.request.headers.get("x-request-id") ?? crypto.randomUUID() });
      for (const name of ["accept", "content-type"]) {
        const value = context.request.headers.get(name); if (value) headers.set(name, value);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs(context.env));
      try {
        const response = await fetch(upstreamUrl, {
          method: context.request.method, headers, signal: controller.signal,
          body: context.request.method === "GET" || context.request.method === "HEAD" ? undefined : context.request.body
        });
        const outputHeaders = new Headers();
        for (const name of ["content-type", "content-disposition", "content-length", "cache-control", "x-request-id"]) {
          const value = response.headers.get(name); if (value) outputHeaders.set(name, value);
        }
        return new Response(context.request.method === "HEAD" ? null : response.body, { status: response.status, statusText: response.statusText, headers: outputHeaders });
      } catch {
        return jsonError(controller.signal.aborted ? "backup_worker_timeout" : "backup_worker_unavailable", controller.signal.aborted ? 504 : 502);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

function timeoutMs(env: BackupProxyEnv) {
  const value = Number(env.BACKUP_PROXY_TIMEOUT_MS || 60_000);
  return Number.isFinite(value) ? Math.min(300_000, Math.max(5_000, value)) : 60_000;
}
function jsonError(error: string, status: number) { return new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } }); }
