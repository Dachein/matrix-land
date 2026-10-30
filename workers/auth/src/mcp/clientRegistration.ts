import { canonicalMcpResource } from "../../../../src/shared/mcpResource.ts";
import { authPublicUrl, issuer } from "../configuration.ts";
import { json, readJson } from "../http.ts";
import { recordAuditEvent } from "../repositories/audit.ts";
import { registerMcpOAuthClient } from "../repositories/mcp/clients.ts";
import { type Env, HttpError, type McpAgentType } from "../types.ts";
import { readOptionalString } from "../values.ts";
import { describeMcpOAuthRedirectUri, isSafeMcpOAuthRedirectUri } from "./callbacks.ts";
import { DEVICE_CODE_GRANT_TYPE } from "./constants.ts";

// MCP discovery metadata and public OAuth client registration.
export function mcpOAuthAuthorizationServerMetadata(env: Env) {
  return {
    issuer: issuer(env),
    authorization_endpoint: `${authPublicUrl(env)}/auth/mcp/oauth/authorize`,
    device_authorization_endpoint: `${issuer(env)}/v1/mcp/oauth/device_authorization`,
    token_endpoint: `${issuer(env)}/v1/mcp/oauth/token`,
    registration_endpoint: `${issuer(env)}/v1/mcp/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", DEVICE_CODE_GRANT_TYPE],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: mcpSupportedScopes()
  };
}

export async function registerMcpOAuthPublicClient(request: Request, env: Env, requestId: string) {
  const body = await readJson<Record<string, unknown>>(request);
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
    throw new HttpError(400, "invalid_client_metadata");
  }
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.map(String).map((value) => value.trim()).filter(Boolean)
    : [];
  const redirectUriChecks = redirectUris.map((value) => ({
    ...describeMcpOAuthRedirectUri(value),
    accepted: isSafeMcpOAuthRedirectUri(value)
  }));
  if (redirectUris.length === 0 || redirectUris.length > 12 || redirectUriChecks.some((value) => !value.accepted)) {
    console.warn(JSON.stringify({
      event: "mcp_oauth_registration_redirect_rejected",
      metadataKeys: Object.keys(body).sort(),
      redirectUrisRawType: Array.isArray(body.redirect_uris) ? "array" : typeof body.redirect_uris,
      redirectUriCount: redirectUris.length,
      redirectUris: redirectUriChecks,
      requestId
    }));
    return json({
      error: "invalid_redirect_uri",
      error_description: "redirect_uri is not allowed; use a loopback redirect_uri",
      requestId
    }, {
      status: 400,
      headers: { "Cache-Control": "no-store" }
    });
  }
  const clientName = readOptionalString(body.client_name) ?? "Workspace MCP client";
  const agentType = inferMcpOAuthAgentType(body, request);
  const client = await registerMcpOAuthClient(env, {
    agentType,
    clientName,
    redirectUris
  });
  await recordAuditEvent(env, {
    action: "mcp_oauth_client_registered",
    clientAppId: client.clientId,
    decision: "allow",
    metadata: { agentType: client.agentType, redirectUriCount: client.redirectUris.length },
    requestId,
    resourceId: client.clientId,
    resourceType: "mcp_oauth_client"
  });
  return json({
    client_id: client.clientId,
    client_name: client.clientName,
    agent_type: client.agentType,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"]
  }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

function inferMcpOAuthAgentType(body: Record<string, unknown>, request: Request): McpAgentType {
  const explicit = readOptionalString(body.agent_type ?? body.agentType);
  if (explicit) {
    const normalized = normalizePublicMcpAgentType(explicit);
    if (!normalized) {
      throw new HttpError(400, "invalid_client_metadata");
    }
    return normalized;
  }

  const hint = [
    readOptionalString(body.client_name),
    readOptionalString(body.software_id),
    request.headers.get("user-agent")
  ].filter(Boolean).join(" ").toLowerCase();
  if (/work\s*buddy/.test(hint)) return "workbuddy";
  if (/claude/.test(hint)) return "claude-code";
  if (/cursor/.test(hint)) return "cursor";
  return "codex";
}

function normalizePublicMcpAgentType(value: string): McpAgentType | undefined {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  return normalized === "claude-code" || normalized === "codex" || normalized === "cursor" || normalized === "workbuddy"
    ? normalized
    : undefined;
}

export function canonicalMcpOAuthResource(value: string | undefined, env: Pick<Env, "MCP_RESOURCE_URL">) {
  return canonicalMcpResource(value, env.MCP_RESOURCE_URL);
}

export function mcpSupportedScopes() {
  return [
    "workspace:mail:read", "workspace:mail:write", "workspace:mail:send",
    "workspace:forum:read", "workspace:forum:write", "workspace:hub:read",
    "workspace:apps:read", "workspace:apps:write", "workspace:knowledge:read",
    "workspace:knowledge:write", "workspace:knowledge:share"
  ];
}
