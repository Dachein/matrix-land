import { HttpError } from "./types.ts";

export function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Response(body === null ? null : JSON.stringify(body), {
    ...init,
    headers: withCors(headers)
  });
}

export async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new HttpError(415, "json_required");
  }

  try {
    return await request.json() as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new HttpError(400, "invalid_json");
    throw error;
  }
}

export function errorResponse(error: unknown, requestId?: string) {
  if (error instanceof HttpError) {
    return json({ error: error.code, message: error.message, requestId }, { status: error.status });
  }

  console.error("auth_worker_error", {
    errorName: error instanceof Error ? error.name : "NonErrorThrown",
    requestId
  });
  return json({ error: "auth_worker_error", requestId }, { status: 500 });
}

export function bearerToken(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

type CorsEnv = {
  AUTH_PUBLIC_URL?: string;
  AUTH_WORKER_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  PORTAL_URL?: string;
};

export function corsPreflightResponse(request: Request, env: CorsEnv) {
  return new Response(null, {
    status: 204,
    headers: withCors(new Headers(), request, env)
  });
}

export function withCorsResponse(response: Response, request: Request, env: CorsEnv) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: withCors(new Headers(response.headers), request, env)
  });
}

export function withCors(headers = new Headers(), request?: Request, env: CorsEnv = {}) {
  const next = new Headers(headers);
  const allowedOrigin = allowedCorsOrigin(request?.headers.get("origin") ?? null, request, env);

  if (allowedOrigin) {
    next.set("Access-Control-Allow-Origin", allowedOrigin);
  } else {
    next.delete("Access-Control-Allow-Origin");
    next.delete("Access-Control-Allow-Credentials");
  }

  appendVary(next, "Origin");
  next.set("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  next.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
  next.set("Access-Control-Expose-Headers", "x-request-id");
  return next;
}

function allowedCorsOrigin(origin: string | null, request: Request | undefined, env: CorsEnv) {
  if (!origin) {
    return originFromUrl(env.PORTAL_URL);
  }

  if (request && isLocalOrigin(origin) && isLocalRequest(request)) {
    return origin;
  }

  return configuredCorsOrigins(env).has(origin) ? origin : "";
}

function configuredCorsOrigins(env: CorsEnv) {
  const origins = new Set<string>();

  [env.PORTAL_URL, env.AUTH_PUBLIC_URL, env.AUTH_WORKER_URL, env.CORS_ALLOWED_ORIGINS]
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
