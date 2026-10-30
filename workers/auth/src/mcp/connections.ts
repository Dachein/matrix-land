import { withDefaultAgent } from "../identity/defaultAgent.ts";
import { authPublicUrl, issuer } from "../configuration.ts";
import { json, readJson } from "../http.ts";
import { readUserFromBody } from "../identity/users.ts";
import { readMcpConnection, readMcpConnectionStatus, revokeMcpConnection, touchMcpConnection } from "../repositories/mcp/connections.ts";
import { recordAuditEvent } from "../repositories/audit.ts";
import { resolveAuthoritativeAuthUserSnapshot } from "../repositories/users/login.ts";
import { requireMcpApprovalToken } from "../serviceAuthorization.ts";
import { verifyMcpAccessToken } from "../token.ts";
import { type Env, HttpError } from "../types.ts";
import { readString, requireText } from "../values.ts";

// MCP connection status, revocation and token introspection.
export async function getMcpConnectionStatus(request: Request, env: Env, requestId: string) {
  requireMcpApprovalToken(request, env);
  const body = await readJson<Record<string, unknown>>(request);
  const user = readUserFromBody(body.user);
  const userId = requireText(body.userId ?? body.user_id ?? user?.id, "missing_user_id", 160);
  const status = await readMcpConnectionStatus(env, userId);

  return json({ status, requestId });
}

export async function revokeMcpConnectionRequest(request: Request, env: Env, requestId: string) {
  requireMcpApprovalToken(request, env);
  const body = await readJson<Record<string, unknown>>(request);
  const user = readUserFromBody(body.user);
  const userId = requireText(body.userId ?? body.user_id ?? user?.id, "missing_user_id", 160);
  const connectionId = requireText(body.connectionId ?? body.connection_id, "missing_connection_id", 180);
  const connection = await revokeMcpConnection(env, userId, connectionId);

  await recordAuditEvent(env, {
    action: "mcp_connection_revoked",
    actorUserId: userId,
    clientAppId: connection.clientId,
    decision: "allow",
    metadata: {
      agentType: connection.agentType,
      credentialRejectedOnNextRequest: true,
      displayName: connection.displayName,
      tokenRevoked: true,
      tokenValidUntilExpiry: false
    },
    reason: "user_removed_connection_record",
    requestId,
    resourceId: connection.id,
    resourceType: "mcp_connection"
  });

  return json({
    connection,
    credentialRejectedOnNextRequest: true,
    revoked: true,
    tokenRevoked: true,
    tokenValidUntilExpiry: false,
    requestId
  });
}

export async function introspectMcpToken(request: Request, env: Env, requestId: string) {
  const body = await readJson<Record<string, unknown>>(request);
  const token = requireText(body.token, "missing_token", 4096);
  const payload = await verifyMcpAccessToken(env, token);

  const audiences = Array.isArray(payload.aud) ? payload.aud.map(String) : [readString(payload.aud)];
  if (payload.typ !== "mcp_access" || !audiences.includes("workspace-mcp") || readString(payload.iss) !== issuer(env)) {
    throw new HttpError(401, "invalid_mcp_token");
  }

  const connectionId = requireText(payload.connection_id, "missing_connection_id", 180);
  const sub = requireText(payload.sub, "invalid_mcp_token_subject", 180);
  const clientId = requireText(payload.client_id, "invalid_mcp_token_client", 180);
  const connection = await readMcpConnection(env, connectionId);

  if (!connection) {
    return inactiveMcpConnectionIntrospection(
      env,
      requestId,
      connectionId,
      "mcp_connection_reauthorization_required",
      "connection_not_found"
    );
  }

  if (connection.status === "revoked") {
    return inactiveMcpConnectionIntrospection(
      env,
      requestId,
      connectionId,
      connection.statusReason === "idle_expired" ? "mcp_connection_idle_expired" : "mcp_connection_revoked",
      connection.statusReason === "idle_expired" ? "idle_expired" : "revoked"
    );
  }

  if (connection.userId !== sub || connection.clientId !== clientId) {
    return inactiveMcpConnectionIntrospection(
      env,
      requestId,
      connectionId,
      "mcp_connection_binding_mismatch",
      connection.userId !== sub ? "subject_mismatch" : "client_mismatch"
    );
  }

  // Existing connections survive directory migrations, but their embedded
  // identity claims must never authorize an old department or a disabled user.
  const user = await resolveAuthoritativeAuthUserSnapshot(env, { id: sub }).catch((error) => {
    if (error instanceof HttpError && error.code === "auth_user_not_found") return undefined;
    throw error;
  });
  if (!user || user.status !== "active") {
    return inactiveMcpConnectionIntrospection(env, requestId, connectionId,
      "mcp_connection_reauthorization_required", "user_inactive");
  }

  // This conditional update is the authorization linearization point. If a
  // concurrent revoke wins after the read above, no activity is recorded and
  // the request is treated as revoked instead of returning a stale success.
  if (!await touchMcpConnection(env, connectionId)) {
    const currentConnection = await readMcpConnection(env, connectionId);
    return inactiveMcpConnectionIntrospection(
      env,
      requestId,
      connectionId,
      currentConnection?.statusReason === "idle_expired"
        ? "mcp_connection_idle_expired"
        : currentConnection ? "mcp_connection_revoked" : "mcp_connection_reauthorization_required",
      currentConnection?.statusReason === "idle_expired"
        ? "idle_expired"
        : currentConnection ? "revoked" : "connection_not_found"
    );
  }

  return json({
    active: true,
    authenticatedAt: connection.createdAt,
    aud: payload.aud,
    clientId,
    connectionId,
    exp: payload.exp,
    principal: {
      defaultAgent: (await withDefaultAgent(env, user)).defaultAgent,
      agentType: payload.agent_type,
      clientId,
      connectionId,
      department: user.department,
      departmentId: user.departmentId,
      departmentPath: user.departmentPath ?? [],
      email: user.email,
      name: user.name,
      orgId: payload.org_id,
      role: user.role,
      scopes: Array.isArray(payload.scopes) ? payload.scopes.map(String) : [],
      sub,
      team: user.team,
      teamId: user.teamId,
      teamPath: user.teamPath ?? []
    },
    requestId
  });
}

function inactiveMcpConnectionIntrospection(
  env: Env,
  requestId: string,
  connectionId: string,
  error: "mcp_connection_binding_mismatch" | "mcp_connection_idle_expired" | "mcp_connection_reauthorization_required" | "mcp_connection_revoked",
  reason: "client_mismatch" | "connection_not_found" | "idle_expired" | "revoked" | "subject_mismatch" | "user_inactive"
) {
  return json({
    active: false,
    authorization_url: `${authPublicUrl(env)}/auth/mcp/oauth/authorize`,
    authorization_server: issuer(env),
    connectionId,
    error,
    reason,
    reauthorize: true,
    requestId
  });
}

export function normalizeAdminMcpConnectionStatus(value: unknown): "active" | "inactive" | "all" {
  return value === "inactive" || value === "all" ? value : "active";
}
