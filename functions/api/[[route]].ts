import { apiServices } from "./apiServices.ts";
import type { Env } from "./env.ts";
import {
  corsPreflightResponse,
  HttpError,
  json,
  requestIdForRequest,
  requestWithRequestId,
  stableErrorCode,
  withCorsResponse,
  withRequestId
} from "./http.ts";
import { dispatchApiRoute } from "./routes.ts";

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const requestId = requestIdForRequest(context.request);
  const request = requestWithRequestId(context.request, requestId);
  const env = envWithPortalAuthToken(context.env);
  const dispatchContext = contextWithRequestAndEnv(context, request, env);

  if (context.request.method === "OPTIONS") {
    return withRequestId(corsPreflightResponse(request, env), requestId);
  }

  try {
    return finalizeResponse(await dispatchApiRoute(dispatchContext, apiServices, path), request, env, requestId);
  } catch (error) {
    if (error instanceof HttpError) {
      return finalizeResponse(
        json({ error: stableErrorCode(error.message, "http_error") }, { status: error.status }),
        request,
        env,
        requestId
      );
    }

    console.error({
      event: "pages_api_unhandled_error",
      requestId,
      cause: error instanceof Error ? error.name : "NonErrorThrown"
    });
    return finalizeResponse(json({ error: "internal_error" }, { status: 500 }), request, env, requestId);
  }
};

function contextWithRequestAndEnv<TContext extends { env: Env; request: Request }>(
  context: TContext,
  request: Request,
  env: Env
): TContext {
  return Object.create(context, {
    env: {
      configurable: true,
      enumerable: true,
      value: env
    },
    request: {
      configurable: true,
      enumerable: true,
      value: request
    }
  }) as TContext;
}

export function envWithPortalAuthToken(env: Env): Env {
  const token = env.PORTAL_AUTH_SERVICE_TOKEN?.trim() || env.AUTH_SERVICE_TOKEN?.trim();
  if (!token || token === env.AUTH_SERVICE_TOKEN) {
    return env;
  }

  return Object.create(env, {
    AUTH_SERVICE_TOKEN: {
      configurable: true,
      enumerable: true,
      value: token
    }
  }) as Env;
}

async function finalizeResponse(response: Response, request: Request, env: Env, requestId: string) {
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
