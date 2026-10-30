export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;

export function requestIdForRequest(request: Request) {
  const incoming = request.headers.get("x-request-id")?.trim() ?? "";
  return REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
}

export function stableErrorCode(value: unknown, fallback = "internal_error") {
  const firstSegment = typeof value === "string" ? value.split(":", 1)[0].trim() : "";
  return ERROR_CODE_PATTERN.test(firstSegment) ? firstSegment : fallback;
}

export function withRequestId(response: Response, requestId: string) {
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function requestWithRequestId(request: Request, requestId: string) {
  const headers = new Headers(request.headers);
  headers.set("X-Request-Id", requestId);
  return new Request(request, { headers });
}

export function requireDb(db: D1Database | undefined) {
  if (!db) {
    throw new HttpError(503, "database_not_configured");
  }

  return db;
}

export function requireConfiguredSecret(value: string | undefined, name: string) {
  const normalized = value?.trim();

  if (!normalized) {
    throw new HttpError(503, `${name}_not_configured`);
  }

  return normalized;
}

export function parseJsonBody(value: string, errorCode = "llm_gateway_invalid_json") {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new HttpError(502, errorCode);
  }
}

export function redirect(location: string, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("location", location);

  return new Response(null, {
    ...init,
    status: init.status ?? 302,
    headers
  });
}

export async function readBody<T>(request: Request): Promise<T> {
  if (request.headers.get("content-type")?.includes("application/json")) {
    return request.json() as Promise<T>;
  }

  return {} as T;
}

export function json(body: unknown, init: ResponseInit = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers
    }
  });
}

type CorsEnv = {
  AUTH_WORKER_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  APPS_WORKER_URL?: string;
  LITELLM_URL?: string;
  MCP_RESOURCE_URL?: string;
  PORTAL_URL?: string;
};

export function corsPreflightResponse(request: Request, env: CorsEnv) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, env)
  });
}

export function withCorsResponse(response: Response, request: Request, env: CorsEnv) {
  const headers = corsHeaders(request, env, new Headers(response.headers));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
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
  next.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  next.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id");
  next.set("Access-Control-Expose-Headers", "X-Request-Id");
  return next;
}

function allowedCorsOrigin(origin: string | null, request: Request, env: CorsEnv) {
  if (!origin) {
    return defaultPortalOrigin(env);
  }

  if (isLocalOrigin(origin) && isLocalRequest(request)) {
    return origin;
  }

  return configuredCorsOrigins(env).has(origin) ? origin : "";
}

function configuredCorsOrigins(env: CorsEnv) {
  const origins = new Set<string>();

  [
    env.PORTAL_URL,
    env.AUTH_WORKER_URL,
    env.APPS_WORKER_URL,
    env.LITELLM_URL,
    env.MCP_RESOURCE_URL,
    env.CORS_ALLOWED_ORIGINS
  ]
    .flatMap((value) => String(value ?? "").split(","))
    .map(originFromUrl)
    .filter(Boolean)
    .forEach((origin) => origins.add(origin));

  return origins;
}

function defaultPortalOrigin(env: CorsEnv) {
  return originFromUrl(env.PORTAL_URL);
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

  const parts = current.split(",").map((part) => part.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) {
    headers.set("Vary", `${current}, ${value}`);
  }
}
