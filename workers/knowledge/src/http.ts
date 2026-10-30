import type { Env } from "./types.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function bearerToken(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
}

export async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return {} as T;
  }
  try {
    return await request.json() as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new HttpError(400, "invalid_json");
    throw error;
  }
}

export function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers({ "Content-Type": "application/json" });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return new Response(body === null ? null : JSON.stringify(body), { ...init, headers });
}

export function html(body: string, init: ResponseInit = {}) {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return new Response(body, { ...init, headers });
}

export function errorResponse(error: unknown, requestId: string) {
  if (error instanceof HttpError) {
    return json({ error: error.code, message: error.message, requestId }, { status: error.status });
  }
  console.error("knowledge_worker_error", {
    errorName: error instanceof Error ? error.name : "NonErrorThrown",
    requestId
  });
  return json({ error: "knowledge_worker_error", requestId }, { status: 500 });
}

export function withCors(response: Response, request: Request, env: Env, requestId: string) {
  const headers = corsHeaders(request, env, new Headers(response.headers));
  headers.set("x-request-id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function corsHeaders(request: Request, env: Env, headers = new Headers()) {
  const next = new Headers(headers);
  const origin = request.headers.get("origin");
  const allowedOrigin = allowedCorsOrigin(origin, request, env);
  if (allowedOrigin) {
    next.set("Access-Control-Allow-Origin", allowedOrigin);
    next.set("Access-Control-Allow-Credentials", "true");
  }
  else { next.delete("Access-Control-Allow-Origin"); next.delete("Access-Control-Allow-Credentials"); }
  next.set("Vary", appendHeader(next.get("Vary"), "Origin"));
  next.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  next.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, X-Workspace-User-Id, X-Workspace-User-Email, X-Workspace-User-Name, X-Workspace-Org-Id, X-Workspace-Scopes");
  next.set("Access-Control-Expose-Headers", "x-request-id");
  return next;
}

function allowedCorsOrigin(origin: string | null, request: Request, env: Env) {
  if (!origin) {
    return originFromUrl(env.PORTAL_URL);
  }
  if (isLocalOrigin(origin) && isLocalRequest(request)) {
    return origin;
  }
  return configuredCorsOrigins(env).has(origin) ? origin : "";
}

function configuredCorsOrigins(env: Env) {
  const origins = new Set<string>();
  [env.PORTAL_URL, env.AUTH_PUBLIC_URL, env.AUTH_WORKER_URL, env.KNOWLEDGE_PUBLIC_URL, env.CORS_ALLOWED_ORIGINS]
    .flatMap((value) => String(value ?? "").split(","))
    .map(originFromUrl)
    .filter(Boolean)
    .forEach((origin) => origins.add(origin));
  return origins;
}

function isLocalOrigin(origin: string) {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

function isLocalRequest(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

function originFromUrl(value: string | undefined) {
  const text = value?.trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.origin : "";
  } catch {
    return "";
  }
}

function appendHeader(current: string | null, value: string) {
  if (!current) return value;
  const parts = current.split(",").map((part) => part.trim().toLowerCase());
  return parts.includes(value.toLowerCase()) ? current : `${current}, ${value}`;
}
