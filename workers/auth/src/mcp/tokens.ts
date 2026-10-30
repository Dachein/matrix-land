import { issuer, mcpOAuthAccessTokenTtlSeconds } from "../configuration.ts";
import { json } from "../http.ts";
import { consumeMcpDeviceCode } from "../repositories/mcp/device.ts";
import {
  consumeMcpOAuthAuthorizationCode,
  issueMcpRefreshToken,
  readMcpRefreshTokenGrant,
  rotateMcpRefreshToken
} from "../repositories/mcp/oauthCredentials.ts";
import { ensureMcpOAuthClient, readMcpOAuthClient } from "../repositories/mcp/clients.ts";
import { readMcpConnection, touchMcpConnection } from "../repositories/mcp/connections.ts";
import { recordAuditEvent } from "../repositories/audit.ts";
import { resolveAuthoritativeAuthUserSnapshot } from "../repositories/users/login.ts";
import { signMcpAccessToken } from "../token.ts";
import { type Env, HttpError } from "../types.ts";
import { requireText } from "../values.ts";
import { DEVICE_CODE_GRANT_TYPE, WORKSPACE_WORKBUDDY_CLI_CLIENT_ID } from "./constants.ts";

// OAuth authorization-code, refresh-token and supported device-grant exchange.
export async function exchangeMcpOAuthToken(request: Request, env: Env, requestId: string) {
  if (!request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) {
    throw new HttpError(415, "form_required");
  }
  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type");
  const oauthClientId = requireText(form.get("client_id"), "invalid_client", 200);
  if (grantType === DEVICE_CODE_GRANT_TYPE && oauthClientId === WORKSPACE_WORKBUDDY_CLI_CLIENT_ID) {
    await ensureMcpOAuthClient(env, {
      agentType: "workbuddy",
      clientId: WORKSPACE_WORKBUDDY_CLI_CLIENT_ID,
      clientName: "Workspace CLI for WorkBuddy"
    });
  }
  const client = await readMcpOAuthClient(env, oauthClientId);
  if (!client) {
    throw new HttpError(401, "invalid_client");
  }

  let grant: { codeChallenge?: string; connectionId: string; oauthClientId: string; resourceUrl: string; scopes: string[]; userId: string };
  let presentedRefreshToken: string | undefined;
  if (grantType === "authorization_code") {
    const verifier = requireText(form.get("code_verifier"), "invalid_grant", 180);
    grant = await consumeMcpOAuthAuthorizationCode(env, {
      code: requireText(form.get("code"), "invalid_grant", 500),
      codeChallenge: await pkceS256(verifier),
      oauthClientId,
      redirectUri: requireText(form.get("redirect_uri"), "invalid_grant", 1000)
    });
  } else if (grantType === "refresh_token") {
    presentedRefreshToken = requireText(form.get("refresh_token"), "invalid_grant", 500);
    grant = await readMcpRefreshTokenGrant(env, presentedRefreshToken, oauthClientId);
  } else if (grantType === DEVICE_CODE_GRANT_TYPE && oauthClientId === WORKSPACE_WORKBUDDY_CLI_CLIENT_ID) {
    try {
      const device = await consumeMcpDeviceCode(env, requireText(form.get("device_code"), "invalid_grant", 500));
      grant = {
        connectionId: device.connectionId,
        oauthClientId,
        resourceUrl: device.resourceUrl,
        scopes: device.scopes,
        userId: device.user.id
      };
    } catch (error) {
      if (error instanceof HttpError && ["authorization_pending", "access_denied", "expired_token"].includes(error.code)) {
        return json({ error: error.code }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      throw error;
    }
  } else {
    throw new HttpError(400, "unsupported_grant_type");
  }

  const accessToken = await issueMcpOAuthAccessToken(env, grant);
  const refreshToken = grantType === "refresh_token"
    ? await rotateMcpRefreshToken(env, presentedRefreshToken!, grant)
    : await issueMcpRefreshToken(env, grant);
  await recordAuditEvent(env, {
    action: grantType === "refresh_token" ? "mcp_access_token_refreshed" : "mcp_access_token_issued",
    actorUserId: grant.userId,
    clientAppId: oauthClientId,
    decision: "allow",
    metadata: { connectionId: grant.connectionId, grantType },
    requestId,
    resourceId: grant.connectionId,
    resourceType: "mcp_connection"
  });
  return json({ ...accessToken, refresh_token: refreshToken }, { headers: { "Cache-Control": "no-store" } });
}

async function issueMcpOAuthAccessToken(
  env: Env,
  grant: { connectionId: string; oauthClientId: string; resourceUrl: string; scopes: string[]; userId: string }
) {
  if (!await touchMcpConnection(env, grant.connectionId)) {
    throw new HttpError(400, "invalid_grant");
  }
  const connection = await readMcpConnection(env, grant.connectionId);
  if (!connection || connection.status !== "active" || connection.userId !== grant.userId || connection.clientId !== "workspace-ai-mcp") {
    throw new HttpError(400, "invalid_grant");
  }
  const user = await resolveAuthoritativeAuthUserSnapshot(env, { id: grant.userId });
  if (user.status && user.status !== "active") {
    throw new HttpError(403, "mcp_user_inactive");
  }
  const ttlSeconds = mcpOAuthAccessTokenTtlSeconds(env);
  const issuedAt = Math.floor(Date.now() / 1000);
  const accessToken = await signMcpAccessToken(env, {
    typ: "mcp_access",
    iss: issuer(env),
    aud: "workspace-mcp",
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    org_id: env.WORKSPACE_ORG_ID || env.ENTRA_TENANT_ID,
    team: user.team,
    team_id: user.teamId,
    team_path: user.teamPath ?? [],
    department: user.department,
    department_id: user.departmentId,
    department_path: user.departmentPath ?? [],
    client_id: connection.clientId,
    oauth_client_id: grant.oauthClientId,
    connection_id: connection.id,
    agent_type: connection.agentType,
    resource: grant.resourceUrl,
    scopes: grant.scopes,
    iat: issuedAt,
    jti: crypto.randomUUID(),
    exp: issuedAt + ttlSeconds
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ttlSeconds,
    scope: grant.scopes.join(" ")
  };
}

async function pkceS256(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
