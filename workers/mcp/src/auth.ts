import { defaultAgentInfo } from "../../../sdk/auth/types.ts";
import { authWorkerUrl, bearerToken, readString, readStringArray } from "./http.ts";
import { HttpError, type Env, type Principal } from "./types.ts";

const INACTIVE_CONNECTION_ERRORS = new Set([
  "mcp_connection_binding_mismatch",
  "mcp_connection_inactive",
  "mcp_connection_idle_expired",
  "mcp_connection_not_found",
  "mcp_connection_reauthorization_required",
  "mcp_connection_revoked"
]);

const UPSTREAM_TOKEN_ERROR_CODES = new Map([
  ["invalid_mcp_token", "invalid_mcp_token"],
  ["invalid_token_payload", "invalid_mcp_token_payload"],
  ["invalid_token_signature", "invalid_mcp_token_signature"],
  ["malformed_token", "malformed_mcp_token"],
  ["token_expired", "mcp_token_expired"]
]);

export async function resolvePrincipal(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Principal> {
  assertSafeDevAuthBypass(request, env);

  if (env.DEV_AUTH_BYPASS === "1") {
    return {
      agentType: "codex",
      authenticatedAt: request.headers.get("x-workspace-authenticated-at") ?? new Date().toISOString(),
      clientId: "dev-codex",
      connectionId: "dev-connection",
      department: request.headers.get("x-workspace-department-name") ?? undefined,
      departmentId: request.headers.get("x-workspace-department-id") ?? undefined,
      departmentPath: readHeaderPath(request, "x-workspace-department-path"),
      email: request.headers.get("x-workspace-user-email") ?? "local.admin@example.invalid",
      name: request.headers.get("x-workspace-user-name") ?? "Local Admin",
      orgId: request.headers.get("x-workspace-org-id") ?? undefined,
      role: request.headers.get("x-workspace-role") ?? "admin",
      scopes: (request.headers.get("x-workspace-scopes") ?? "workspace:forum:read,workspace:forum:write,workspace:hub:read,workspace:apps:read,workspace:apps:write,workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
      sub: request.headers.get("x-workspace-user-id") ?? "local-dev-admin",
      team: request.headers.get("x-workspace-team-name") ?? "AI Adoption",
      teamId: request.headers.get("x-workspace-team-id") ?? undefined,
      teamPath: readHeaderPath(request, "x-workspace-team-path")
    };
  }

  const token = bearerToken(request);
  if (!token) {
    throw new HttpError(401, "missing_mcp_token");
  }

  const payload = await verifyJwt(token, mcpAccessSecret(env));
  if (readString(payload.typ) !== "mcp_access") {
    throw new HttpError(401, "invalid_mcp_token_type");
  }

  const audience = payload.aud;
  const audiences = Array.isArray(audience) ? audience.map(String) : [String(audience ?? "")];
  if (!audiences.includes("workspace-mcp")) {
    throw new HttpError(401, "invalid_mcp_token_audience");
  }

  const expectedIssuer = env.AUTH_ISSUER?.trim();
  if (expectedIssuer && readString(payload.iss) !== expectedIssuer) {
    throw new HttpError(401, "invalid_mcp_token_issuer");
  }

  const expectedResource = env.MCP_RESOURCE_URL?.trim().replace(/\/+$/, "");
  const tokenResource = readString(payload.resource).trim().replace(/\/+$/, "");
  if (expectedResource && tokenResource !== expectedResource) {
    throw new HttpError(401, "invalid_mcp_token_resource");
  }

  const sub = readString(payload.sub).trim();
  if (!sub) {
    throw new HttpError(401, "invalid_mcp_token_subject");
  }

  const connectionId = readString(payload.connection_id).trim();
  if (!connectionId) {
    throw new HttpError(401, "invalid_mcp_token_connection");
  }

  const principal: Principal = {
    agentType: readSupportedAgent(payload.agent_type),
    clientId: readString(payload.client_id) || undefined,
    connectionId,
    department: readString(payload.department) || undefined,
    departmentId: readString(payload.department_id ?? payload.departmentId) || undefined,
    departmentPath: readStringArray(payload.department_path ?? payload.departmentPath),
    email: readString(payload.email) || undefined,
    name: readString(payload.name) || undefined,
    orgId: readString(payload.org_id ?? payload.orgId) || undefined,
    role: readString(payload.role) || undefined,
    scopes: readStringArray(payload.scopes),
    sub,
    team: readString(payload.team) || undefined,
    teamId: readString(payload.team_id ?? payload.teamId) || undefined,
    teamPath: readStringArray(payload.team_path ?? payload.teamPath)
  };

  const activeConnection = await assertActiveMcpConnection(token, principal, env, fetchImpl);
  principal.authenticatedAt = activeConnection.authenticatedAt;
  Object.assign(principal, activeConnection.identity);
  return principal;
}

async function assertActiveMcpConnection(token: string, principal: Principal, env: Env, fetchImpl: typeof fetch) {
  const introspectionToken = env.MCP_INTROSPECTION_TOKEN?.trim() || env.AUTH_SERVICE_TOKEN?.trim();
  if (!introspectionToken) {
    throw new HttpError(503, "mcp_introspection_token_not_configured");
  }

  let response: Response;
  try {
    response = await fetchImpl(`${authWorkerUrl(env)}/v1/mcp/tokens/introspect`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${introspectionToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ token })
    });
  } catch {
    throw new HttpError(503, "mcp_introspection_unavailable");
  }

  let payload: Record<string, unknown>;
  try {
    const value = await response.json() as unknown;
    if (!isRecord(value)) {
      throw new Error("invalid_payload");
    }
    payload = value;
  } catch {
    throw new HttpError(502, "mcp_introspection_invalid_response");
  }

  const upstreamError = readString(payload.error).trim();
  if (payload.active === false || payload.reauthorize === true || INACTIVE_CONNECTION_ERRORS.has(upstreamError)) {
    throw new HttpError(401, "mcp_connection_revoked");
  }

  if (!response.ok) {
    const localTokenError = UPSTREAM_TOKEN_ERROR_CODES.get(upstreamError);
    if (response.status === 401 && localTokenError) {
      throw new HttpError(401, localTokenError);
    }
    throw new HttpError(response.status >= 500 ? 503 : 502, response.status >= 500
      ? "mcp_introspection_unavailable"
      : "mcp_introspection_failed");
  }

  if (payload.active !== true) {
    throw new HttpError(502, "mcp_introspection_invalid_response");
  }

  const introspectedPrincipal = isRecord(payload.principal) ? payload.principal : {};
  const connectionId = readString(payload.connectionId ?? payload.connection_id ?? introspectedPrincipal.connectionId ?? introspectedPrincipal.connection_id).trim();
  const sub = readString(introspectedPrincipal.sub).trim();
  const clientId = readString(payload.clientId ?? payload.client_id ?? introspectedPrincipal.clientId ?? introspectedPrincipal.client_id).trim();
  if (!connectionId || !sub || !clientId) {
    throw new HttpError(502, "mcp_introspection_invalid_response");
  }

  if (connectionId !== principal.connectionId || sub !== principal.sub || clientId !== principal.clientId) {
    throw new HttpError(401, "mcp_connection_revoked");
  }

  return {
    authenticatedAt: readString(payload.authenticatedAt ?? payload.authenticated_at).trim() || undefined,
    identity: {
      defaultAgent: defaultAgentInfo(introspectedPrincipal.defaultAgent),
      department: readString(introspectedPrincipal.department) || undefined,
      departmentId: readString(introspectedPrincipal.departmentId) || undefined,
      departmentPath: readStringArray(introspectedPrincipal.departmentPath),
      email: readString(introspectedPrincipal.email) || undefined,
      name: readString(introspectedPrincipal.name) || undefined,
      role: readString(introspectedPrincipal.role) || undefined,
      team: readString(introspectedPrincipal.team) || undefined,
      teamId: readString(introspectedPrincipal.teamId) || undefined,
      teamPath: readStringArray(introspectedPrincipal.teamPath)
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeDevAuthBypass(request: Request, env: Env) {
  if (env.DEV_AUTH_BYPASS !== "1") {
    return;
  }

  if (isLocalDevelopmentRequest(request)) {
    return;
  }

  throw new HttpError(503, "dev_auth_bypass_forbidden");
}

function isLocalDevelopmentRequest(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function assertScope(principal: Principal, acceptedScopes: string[]) {
  if (principal.scopes.includes("workspace:*") || acceptedScopes.some((scope) => principal.scopes.includes(scope))) {
    return;
  }
  throw new HttpError(403, "insufficient_mcp_scope");
}

export async function signJwt(payload: Record<string, unknown>, secret?: string) {
  const signingSecret = secret?.trim();
  if (!signingSecret) {
    throw new HttpError(503, "downstream_jwt_secret_not_configured");
  }
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256(`${encodedHeader}.${encodedPayload}`, signingSecret);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

async function verifyJwt(token: string, secret: string) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new HttpError(401, "malformed_mcp_token");
  }
  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload || !signature) {
    throw new HttpError(401, "malformed_mcp_token");
  }

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader)) as Record<string, unknown>;
  } catch {
    throw new HttpError(401, "invalid_mcp_token_header");
  }
  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw new HttpError(401, "invalid_mcp_token_header");
  }

  const expected = await hmacSha256(`${encodedHeader}.${encodedPayload}`, secret);
  if (!safeEqual(signature, expected)) {
    throw new HttpError(401, "invalid_mcp_token_signature");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as Record<string, unknown>;
  } catch {
    throw new HttpError(401, "invalid_mcp_token_payload");
  }

  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, "mcp_token_expired");
  }

  return payload;
}

function mcpAccessSecret(env: Env) {
  const secret = env.MCP_ACCESS_JWT_SECRET?.trim();
  if (!secret) {
    throw new HttpError(503, "mcp_access_jwt_secret_not_configured");
  }
  return secret;
}

function readHeaderPath(request: Request, name: string) {
  const value = request.headers.get(name);
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(String).map((item) => item.trim()).filter(Boolean);
    }
  } catch {
    // Accept comma-separated development headers as well as JSON arrays.
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function hmacSha256(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncode(signature);
}

function base64UrlDecode(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function base64UrlEncode(value: string | ArrayBuffer | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function readSupportedAgent(value: unknown) {
  const agent = readString(value).toLowerCase().replaceAll("_", "-");
  return agent === "claude-code" || agent === "codex" || agent === "cursor" || agent === "workbuddy" ? agent : undefined;
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}
