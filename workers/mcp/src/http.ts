import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import { HttpError, SUPPORTED_AGENTS, type Env, type SupportedAgent } from "./types.ts";

export const JSON_HEADERS = {
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version, X-Workspace-Agent",
  "Access-Control-Expose-Headers": "WWW-Authenticate, x-request-id"
};

export function authWorkerUrl(env: Env) {
  return (env.AUTH_WORKER_URL?.trim() || env.AUTH_ISSUER?.trim() || missingConfiguration("AUTH_ISSUER")).replace(/\/+$/, "");
}

export function authPublicUrl(env: Env) {
  return (env.AUTH_PUBLIC_URL?.trim() || authWorkerUrl(env)).replace(/\/+$/, "");
}

export function bearerToken(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export function errorResponse(error: unknown, requestId: string, env: Env, request: Request) {
  if (error instanceof HttpError) {
    const isAuthenticationError = error.status === 401;
    const headers = isAuthenticationError ? authChallengeHeaders(env, request, error.code) : undefined;
    return json({
      error: error.code,
      message: isAuthenticationError ? error.code : error.message,
      requestId,
      ...(isAuthenticationError ? reauthorizationDetails(error.code, env, request) : {})
    }, { status: error.status, headers });
  }

  const message = error instanceof Error ? error.message : "unknown_error";
  return json({ error: "workspace_mcp_worker_error", message, requestId }, { status: 500 });
}

export function html(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    ...init,
    headers: responseHeaders("text/html; charset=utf-8", init.headers)
  });
}

export function corsPreflightResponse(request: Request, env: Env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

export function withCorsResponse(response: Response, request: Request, env: Env) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: corsHeaders(request, env, new Headers(response.headers))
  });
}

export function corsHeaders(request: Request, env: Env, headers = new Headers()) {
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

export function json(body: unknown, init: ResponseInit = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    ...init,
    headers: responseHeaders("application/json", init.headers)
  });
}

export function normalizeAgent(value: unknown): SupportedAgent | undefined {
  const agent = readString(value).trim().toLowerCase().replaceAll("_", "-");
  if (SUPPORTED_AGENTS.some((supported) => supported === agent)) {
    return agent as SupportedAgent;
  }
  return undefined;
}

export function normalizePath(pathname: string) {
  return `/${pathname.replace(/^\/+|\/+$/g, "")}`;
}

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

export function readNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function readString(value: unknown) {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

export function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => readString(item).trim()).filter(Boolean);
}

export function resourceUrl(request: Request, env: Env) {
  return (env.MCP_RESOURCE_URL?.trim() || new URL(request.url).origin).replace(/\/+$/, "");
}

export function text(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    ...init,
    headers: responseHeaders("text/plain; charset=utf-8", init.headers)
  });
}

export function reauthorizationDetails(code: string, env: Env, request: Request) {
  return {
    code,
    reauthorize: true,
    authorization_server: (env.AUTH_ISSUER?.trim() || authWorkerUrl(env)).replace(/\/+$/, ""),
    oauth_authorization_endpoint: `${authPublicUrl(env)}/auth/mcp/oauth/authorize`,
    resource_metadata: `${resourceUrl(request, env)}/.well-known/oauth-protected-resource`,
    instructions_url: `${resourceUrl(request, env)}/llms.txt`
  };
}

export function authChallengeHeaders(env: Env, request: Request, errorDescription?: string) {
  const parameters = [
    ...(errorDescription
      ? [`error="invalid_token"`, `error_description="${challengeValue(errorDescription)}"`]
      : []),
    `resource_metadata="${resourceUrl(request, env)}/.well-known/oauth-protected-resource"`,
    `authorization_uri="${(env.AUTH_ISSUER?.trim() || authWorkerUrl(env)).replace(/\/+$/, "")}"`
  ];
  const headers = new Headers({
    "WWW-Authenticate": `Bearer ${parameters.join(", ")}`,
    "Cache-Control": "no-store"
  });
  return corsHeaders(request, env, headers);
}

function challengeValue(value: string) {
  return value.replace(/[^A-Za-z0-9._~:/-]/g, "_").slice(0, 180) || "invalid_mcp_token";
}

function responseHeaders(contentType: string, initHeaders?: HeadersInit) {
  const headers = new Headers(JSON_HEADERS);
  headers.set("Content-Type", contentType);
  new Headers(initHeaders).forEach((value, name) => headers.set(name, value));
  return headers;
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

  [env.PORTAL_URL, env.AUTH_PUBLIC_URL, env.AUTH_WORKER_URL, env.MCP_RESOURCE_URL, env.CORS_ALLOWED_ORIGINS]
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
