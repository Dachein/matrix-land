import { HttpError } from "./types";
import type { Env } from "./types";

export const JSON_HEADERS = {
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Workspace-User-Id, X-Workspace-Org-Id, X-Workspace-Org-Slug, X-Workspace-Scopes",
  "Access-Control-Expose-Headers": "x-request-id"
};

type CorsEnv = Pick<Env, "CORS_ALLOWED_ORIGINS" | "APPS_BASE_DOMAIN" | "LITELLM_URL" | "PLATFORM_MCP_URL">;

export async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return {} as T;
  }

  try {
    return await request.json() as T;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers({ ...JSON_HEADERS, "Content-Type": "application/json" });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return new Response(body === null ? null : JSON.stringify(body), { ...init, headers });
}

export function corsPreflightResponse(request: Request, env: CorsEnv) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, env)
  });
}

export function withCorsResponse(response: Response, request: Request, env: CorsEnv) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: corsHeaders(request, env, new Headers(response.headers))
  });
}

export function corsHeaders(request: Request, env: CorsEnv, headers = new Headers()) {
  const next = new Headers(headers);
  const origin = request.headers.get("origin");
  const allowedOrigin = allowedCorsOrigin(origin, request, env);

  if (allowedOrigin) {
    next.set("Access-Control-Allow-Origin", allowedOrigin);
  } else {
    next.delete("Access-Control-Allow-Origin");
    next.delete("Access-Control-Allow-Credentials");
  }

  appendVary(next, "Origin");
  next.set("Access-Control-Allow-Methods", JSON_HEADERS["Access-Control-Allow-Methods"]);
  next.set("Access-Control-Allow-Headers", JSON_HEADERS["Access-Control-Allow-Headers"]);
  next.set("Access-Control-Expose-Headers", JSON_HEADERS["Access-Control-Expose-Headers"]);
  return next;
}

export function errorResponse(error: unknown, requestId: string) {
  if (error instanceof HttpError) {
    return json({ error: error.code, requestId, ...error.details }, { status: error.status });
  }

  console.error("apps_worker_error", {
    errorName: error instanceof Error ? error.name : "NonErrorThrown",
    requestId
  });
  return json({ error: "apps_worker_error", requestId }, { status: 500 });
}

export function normalizePath(pathname: string) {
  return `/${pathname.replace(/^\/+|\/+$/g, "")}`;
}

function allowedCorsOrigin(origin: string | null, request: Request, env: CorsEnv) {
  if (!origin) {
    return "";
  }

  if (isLocalOrigin(origin) && isLocalRequest(request)) {
    return origin;
  }

  return configuredCorsOrigins(env).has(origin) ? origin : "";
}

function configuredCorsOrigins(env: CorsEnv) {
  const origins = new Set<string>();
  const baseDomain = env.APPS_BASE_DOMAIN?.trim();

  if (baseDomain) {
    origins.add(`https://apps.${baseDomain}`);
  }

  [env.LITELLM_URL, env.PLATFORM_MCP_URL, env.CORS_ALLOWED_ORIGINS]
    .flatMap((value) => String(value ?? "").split(","))
    .map(originFromUrl)
    .filter(Boolean)
    .forEach((origin) => origins.add(origin));

  return origins;
}

function originFromUrl(value: string | undefined) {
  const text = value?.trim();
  if (!text) {
    return "";
  }

  try {
    const url = new URL(text);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.origin : "";
  } catch {
    return "";
  }
}

function isLocalOrigin(origin: string) {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function isLocalRequest(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function appendVary(headers: Headers, value: string) {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", value);
    return;
  }

  const values = current.split(",").map((part) => part.trim().toLowerCase());
  if (!values.includes(value.toLowerCase())) {
    headers.set("Vary", `${current}, ${value}`);
  }
}
