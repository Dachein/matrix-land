import { bearerToken } from "./http.ts";
import { HttpError, type Env } from "./types.ts";

export type ResourceMintAuth = "service" | "mcp-broker";

// Service credentials authorize platform-to-platform operations only. User
// sessions, app-client authentication and resource ACL remain separate guards.
export function requireServiceToken(request: Request, env: Env) {
  const tokens = serviceTokens(env);
  if (tokens.length === 0) {
    throw new HttpError(503, "auth_service_token_not_configured");
  }

  if (!tokens.includes(bearerToken(request))) {
    throw new HttpError(401, "invalid_service_token");
  }
}

export function requireMokaSyncToken(request: Request, env: Env) {
  const supplied = bearerToken(request);
  const connectorToken = env.MOKA_CONNECTOR_SERVICE_TOKEN?.trim();
  if (serviceTokens(env).includes(supplied)) return;
  if (!connectorToken) throw new HttpError(503, "moka_connector_token_not_configured");
  if (!safeEqual(supplied, connectorToken)) throw new HttpError(401, "invalid_moka_sync_token");
}

export function requireAppRegistrationToken(request: Request, env: Env) {
  const tokens = [
    ...serviceTokens(env),
    env.APPS_AUTH_SERVICE_TOKEN?.trim(),
    env.PUBLICATION_AUTH_SERVICE_TOKEN?.trim()
  ].filter(Boolean) as string[];
  if (tokens.length === 0) {
    throw new HttpError(503, "auth_service_token_not_configured");
  }

  if (!tokens.includes(bearerToken(request))) {
    throw new HttpError(401, "invalid_service_token");
  }
}

export function requireResourceMintToken(request: Request, env: Env): ResourceMintAuth {
  const token = bearerToken(request);
  const tokens = serviceTokens(env);
  if (tokens.includes(token)) {
    return "service";
  }

  const runtimeToken = env.MATE_RUNTIME_AUTH_SERVICE_TOKEN?.trim();
  const brokerToken = env.MCP_INTROSPECTION_TOKEN?.trim();
  if (runtimeToken && safeEqual(runtimeToken, token)) {
    return "service";
  }

  if (brokerToken && safeEqual(brokerToken, token)) {
    return "mcp-broker";
  }

  if (tokens.length === 0 && !runtimeToken && !brokerToken) {
    throw new HttpError(503, "resource_mint_token_not_configured");
  }

  throw new HttpError(401, "invalid_resource_mint_token");
}

export function requireMateRuntimeAuthToken(request: Request, env: Env) {
  const expected = env.MATE_RUNTIME_AUTH_SERVICE_TOKEN?.trim();
  const provided = bearerToken(request);
  if (!expected) throw new HttpError(503, "mate_runtime_auth_service_token_not_configured");
  if (!provided || provided.length !== expected.length) throw new HttpError(401, "invalid_mate_runtime_auth_service_token");
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  if (mismatch !== 0) throw new HttpError(401, "invalid_mate_runtime_auth_service_token");
}

export function requireMcpIntrospectionToken(request: Request, env: Env) {
  const token = bearerToken(request);
  if (env.MCP_INTROSPECTION_TOKEN && token === env.MCP_INTROSPECTION_TOKEN) {
    return;
  }

  if (serviceTokens(env).includes(token)) {
    return;
  }

  throw new HttpError(401, "invalid_mcp_introspection_token");
}

export function requireMcpApprovalToken(request: Request, env: Env) {
  const token = bearerToken(request);
  if (env.MCP_APPROVAL_TOKEN && token === env.MCP_APPROVAL_TOKEN) {
    return;
  }

  if (serviceTokens(env).includes(token)) {
    return;
  }

  throw new HttpError(401, "invalid_mcp_approval_token");
}

export function serviceTokens(env: Env) {
  return [
    env.AUTH_SERVICE_TOKEN,
    env.AUTH_SERVICE_TOKEN_SECONDARY,
    env.PORTAL_AUTH_SERVICE_TOKEN
  ]
    .map((token) => token?.trim())
    .filter(Boolean) as string[];
}

export function safeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

export { requireAppRegistrationToken as requireResourceRegistrationToken };
