import type { PortalCatalog } from "../../../src/shared/types";
import type {
  PortalLiveDeferredContext,
  PortalLivePublisherEnv
} from "../../../src/shared/portalLivePublisher.ts";
import { emitActivityEvent } from "../activity/service.ts";
import { appsOrgContext, appsWorkerBaseUrl } from "./context.ts";
import { appsScopesForProxyRequest } from "./scopes.ts";

type CurrentUser = PortalCatalog["currentUser"];

type AppsProxyEnv = PortalLivePublisherEnv & {
  DB?: D1Database;
  APPS_JWT_SECRET?: string;
  APPS_ORG_ID?: string;
  APPS_ORG_SLUG?: string;
  APPS_PROXY_TIMEOUT_MS?: string;
  APPS_WORKER_URL?: string;
  PORTAL_ISSUER?: string;
  TOKEN_TTL_SECONDS?: string;
};

type AppsProxyContext<TEnv extends AppsProxyEnv> = EventContext<TEnv, string, unknown>;

type AppsProxyDeps<TEnv extends AppsProxyEnv> = {
  currentUserTeamId(db: D1Database, currentUser: CurrentUser, env: TEnv): Promise<string>;
  getTtlSeconds(env: TEnv): number;
  resolveCurrentUser(context: AppsProxyContext<TEnv>): Promise<CurrentUser>;
  signAppsToken(env: TEnv, payload: Record<string, unknown>): Promise<string>;
};

export function createAppsProxyApi<TEnv extends AppsProxyEnv>(deps: AppsProxyDeps<TEnv>) {
  return {
    async proxyAppsWorkerRequest(context: AppsProxyContext<TEnv>, path: string) {
      const currentUser = await deps.resolveCurrentUser(context);
      const upstreamPath = `/${path.replace(/^apps\/?/, "")}`.replace(/\/$/, "") || "/";
      const requestUrl = new URL(context.request.url);
      const upstreamUrl = new URL(`${appsWorkerBaseUrl(context.env)}${upstreamPath}`);
      upstreamUrl.search = requestUrl.search;
      const headers = new Headers();
      const contentType = context.request.headers.get("content-type");
      const accept = context.request.headers.get("accept");
      const requestId = context.request.headers.get("x-request-id") ?? crypto.randomUUID();
      const scopes = appsScopesForProxyRequest(context.request.method, upstreamPath);
      if (upstreamPath.startsWith("/admin/ownership") && currentUser.role !== "admin") {
        return new Response(JSON.stringify({ error: "apps_ownership_admin_required" }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
      const { orgId, orgSlug } = appsOrgContext(context.env, currentUser);
      const token = await deps.signAppsToken(context.env, {
        typ: "apps_access",
        iss: context.env.PORTAL_ISSUER ?? "frontier-workspace",
        sub: currentUser.id,
        org_id: orgId,
        org_slug: orgSlug,
        provider: currentUser.identity.provider,
        oid: currentUser.identity.objectId,
        tid: currentUser.identity.tenantId,
        email: currentUser.email,
        name: currentUser.name,
        platform_role: currentUser.role,
        department_id: currentUser.departmentId,
        department_path: currentUser.departmentPath ?? [],
        scopes,
        exp: Math.floor(Date.now() / 1000) + Math.min(deps.getTtlSeconds(context.env), 900)
      });

      headers.set("Authorization", `Bearer ${token}`);
      headers.set("x-request-id", requestId);
      headers.set("x-workspace-user-id", currentUser.email || currentUser.id);
      headers.set("x-workspace-org-id", orgId);
      headers.set("x-workspace-org-slug", orgSlug);
      headers.set("x-workspace-scopes", scopes.join(","));
      if (accept) {
        headers.set("Accept", accept);
      }
      if (contentType) {
        headers.set("Content-Type", contentType);
      }

      const upstreamBody = context.request.method === "GET" || context.request.method === "HEAD"
        ? undefined
        : await context.request.arrayBuffer();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), appsProxyTimeoutMs(context.env, context.request.method, upstreamPath));
      let response: Response;

      try {
        response = await fetch(upstreamUrl.toString(), {
          method: context.request.method,
          headers,
          signal: controller.signal,
          body: upstreamBody
        });
      } catch {
        const timedOut = controller.signal.aborted;
        return new Response(JSON.stringify({
          error: timedOut ? "apps_worker_timeout" : "apps_worker_unavailable",
          requestId
        }), {
          status: timedOut ? 504 : 502,
          headers: {
            "Content-Type": "application/json",
            "x-request-id": requestId
          }
        });
      } finally {
        clearTimeout(timeout);
      }
      const responseHeaders = new Headers();
      const responseContentType = response.headers.get("content-type");
      const contentDisposition = response.headers.get("content-disposition");
      const upstreamRequestId = response.headers.get("x-request-id") ?? requestId;

      if (responseContentType) {
        responseHeaders.set("Content-Type", responseContentType);
      }
      if (contentDisposition) {
        responseHeaders.set("Content-Disposition", contentDisposition);
      }
      for (const headerName of [
        "cache-control",
        "content-length",
        "x-workspace-source-archive-sha256",
        "x-workspace-source-content-sha256"
      ]) {
        const value = response.headers.get(headerName);
        if (value) {
          responseHeaders.set(headerName, value);
        }
      }
      responseHeaders.set("x-request-id", upstreamRequestId);
      const sourceDownload = context.request.method === "GET"
        && /^\/apps\/[^/]+\/source-snapshots\/[^/]+\/download$/.test(upstreamPath);

      if (sourceDownload) {
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      }

      const responseBody = context.request.method === "HEAD" ? null : await response.arrayBuffer();
      const publishMatch = upstreamPath.match(/^\/apps\/([^/]+)\/publish$/);

      if (response.ok && context.request.method === "POST" && publishMatch?.[1] && responseBody) {
        await recordAppsAppPublishedActivity(
          context.env.DB,
          context.env,
          currentUser,
          decodeURIComponent(publishMatch[1]),
          responseBody,
          responseContentType,
          upstreamRequestId,
          deps,
          context
        );
      }

      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    }
  };
}

export function appsProxyTimeoutMs(env: AppsProxyEnv, method: string, upstreamPath: string) {
  const configured = Number(env.APPS_PROXY_TIMEOUT_MS);
  const mateProvisioning = method === "POST" && (
    upstreamPath === "/mates/default"
    || upstreamPath === "/mates"
    || /^\/mates\/[^/]+\/deploy$/.test(upstreamPath)
    || /^\/mates\/[^/]+\/releases\/[^/]+\/publish$/.test(upstreamPath)
  );
  const fallback = mateProvisioning ? 60_000 : 12_000;
  return Number.isFinite(configured) && configured > 0
    ? Math.min(90_000, Math.max(20, Math.floor(configured)))
    : fallback;
}

export async function recordAppsAppPublishedActivity<TEnv extends AppsProxyEnv>(
  db: D1Database | undefined,
  env: TEnv,
  currentUser: CurrentUser,
  appId: string,
  responseBody: ArrayBuffer,
  contentType: string | null,
  requestId: string,
  deps: Pick<AppsProxyDeps<TEnv>, "currentUserTeamId">,
  publishContext?: PortalLiveDeferredContext<PortalLivePublisherEnv>
) {
  if (!db || !contentType?.includes("json")) {
    return;
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = parseJsonBody(new TextDecoder().decode(responseBody)) as Record<string, unknown>;
  } catch {
    payload = {};
  }

  const app = normalizeUnknownObject(payload.app);
  const appName = readOptionalString(app.name) ?? appId;
  const version = readOptionalString(app.lastDeployedAt) ?? readOptionalString(app.updatedAt) ?? requestId;
  const teamId = await deps.currentUserTeamId(db, currentUser, env);

  await emitActivityEvent(db, {
    scenario: "apps",
    actionType: "apps.app.published",
    actor: currentUser,
    target: {
      type: "apps_app",
      id: appId,
      title: appName
    },
    summary: `${currentUser.name} 部署了应用《${appName}》`,
    href: "#/apps",
    teamId,
    metadata: {
      appId,
      version,
      visibility: readOptionalString(app.visibility),
      productionUrl: readOptionalString(app.productionUrl)
    },
    sourceEventId: `apps.app.published:${appId}:${version}`
  }, publishContext);
}

function parseJsonBody(value: string) {
  if (!value.trim()) {
    return {};
  }

  return JSON.parse(value) as unknown;
}

function normalizeUnknownObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readOptionalString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : undefined;
}
