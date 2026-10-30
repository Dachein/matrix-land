import {
  corsPreflightResponse,
  HttpError,
  json,
  requestIdForRequest,
  requestWithRequestId,
  stableErrorCode,
  withCorsResponse,
  withRequestId
} from "../../../functions/api/http.ts";
import { dispatchMiniappRoutes } from "./routes.ts";
import { createMiniappServices, type MiniappContext, type MiniappEnv } from "./services.ts";
import { cleanupStagedUploads } from "./fileUploads.ts";

const services = createMiniappServices();

export default {
  async scheduled(_event: ScheduledEvent, env: MiniappEnv, executionContext: ExecutionContext) {
    executionContext.waitUntil(cleanupStagedUploads(env.UPLOAD_STAGING));
  },
  async fetch(request: Request, env: MiniappEnv, executionContext: ExecutionContext) {
    const requestId = requestIdForRequest(request);
    const requestWithId = requestAtPublicOrigin(requestWithRequestId(request, requestId), env);

    if (request.method === "OPTIONS") {
      return withRequestId(corsPreflightResponse(requestWithId, env), requestId);
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/?/, "");
      const context = workerContext(requestWithId, env, executionContext);
      const response = await dispatchMiniappRoutes(context, services, path)
        ?? json({ error: "not_found" }, { status: 404 });
      return finalizeResponse(response, requestWithId, env, requestId);
    } catch (error) {
      if (error instanceof HttpError) {
        return finalizeResponse(
          json({ error: stableErrorCode(error.message, "http_error") }, { status: error.status }),
          requestWithId,
          env,
          requestId
        );
      }

      console.error({
        event: "miniapp_api_unhandled_error",
        requestId,
        cause: error instanceof Error ? error.name : "NonErrorThrown"
      });
      return finalizeResponse(json({ error: "internal_error" }, { status: 500 }), requestWithId, env, requestId);
    }
  }
};

function requestAtPublicOrigin(request: Request, env: MiniappEnv) {
  const forwardedOrigin = request.headers.get("x-workspace-miniapp-public-origin")?.trim();
  let configuredOrigin = "";
  try {
    configuredOrigin = env.PORTAL_URL ? new URL(env.PORTAL_URL).origin : "";
  } catch {
    configuredOrigin = "";
  }
  if (!configuredOrigin || forwardedOrigin !== configuredOrigin) return request;

  const url = new URL(request.url);
  const publicUrl = new URL(configuredOrigin);
  url.protocol = publicUrl.protocol;
  url.host = publicUrl.host;
  const headers = new Headers(request.headers);
  headers.delete("x-workspace-miniapp-public-origin");
  return new Request(url, { body: request.body, headers, method: request.method, redirect: request.redirect });
}

function workerContext(request: Request, env: MiniappEnv, executionContext: ExecutionContext) {
  return {
    data: {},
    env,
    functionPath: "/api/miniapp/v1",
    next: () => Promise.resolve(new Response(null, { status: 404 })),
    params: {},
    passThroughOnException: executionContext.passThroughOnException.bind(executionContext),
    request,
    waitUntil: executionContext.waitUntil.bind(executionContext)
  } as MiniappContext;
}

async function finalizeResponse(response: Response, request: Request, env: MiniappEnv, requestId: string) {
  if (response.status === 101) return response;
  const safeResponse = response.status >= 400 ? await safeErrorResponse(response, requestId) : response;
  return withRequestId(withCorsResponse(safeResponse, request, env), requestId);
}

async function safeErrorResponse(response: Response, requestId: string) {
  const payload = response.headers.get("content-type")?.includes("application/json")
    ? await response.clone().json().catch(() => undefined)
    : undefined;
  const code = payload && typeof payload === "object" && !Array.isArray(payload)
    ? stableErrorCode((payload as Record<string, unknown>).error)
    : "internal_error";
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");

  return new Response(JSON.stringify({ error: code, requestId }), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
