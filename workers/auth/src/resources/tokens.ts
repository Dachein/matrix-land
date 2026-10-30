import { appClientFromResource, basicClientCredentials, requireAppClientAuthentication, resolveAppClient } from "../apps/clients.ts";
import { issuer, resourceTokenTtlSeconds } from "../configuration.ts";
import { bearerToken, json, readJson } from "../http.ts";
import { readUserSnapshotFromBody } from "../identity/users.ts";
import { evaluateAppAccess, resolveAppSystemRoles } from "../policy.ts";
import { readResourceClient } from "../repositories/resources.ts";
import { recordAuditEvent } from "../repositories/audit.ts";
import { resolveAuthoritativeAuthUserSnapshot } from "../repositories/users/login.ts";
import { type ResourceMintAuth, serviceTokens } from "../serviceAuthorization.ts";
import { signAuthToken, verifyAuthToken } from "../token.ts";
import { type Env, HttpError } from "../types.ts";
import { readOptionalString, readRecord, readString, readStringList, requireText } from "../values.ts";

// Resource-token minting and introspection enforce caller class and resource policy.
export async function mintResourceToken(request: Request, env: Env, requestId: string, mintAuth: ResourceMintAuth) {
  const body = await readJson<Record<string, unknown>>(request);
  const resourceId = requireText(body.resourceId ?? body.resource_id, "missing_resource_id", 180);
  const resource = await readResourceClient(env, resourceId);

  if (!resource) {
    throw new HttpError(404, "resource_client_not_found");
  }

  const requestedAudience = readOptionalString(body.audience);
  const resourceAudience = readOptionalString(resource.audience);
  const audience = requestedAudience ?? resourceAudience ?? resource.id;
  if (requestedAudience && resourceAudience && requestedAudience !== resourceAudience) {
    throw new HttpError(403, "resource_audience_not_allowed");
  }

  const principal = readRecord(body.principal ?? body.user ?? body.subject);
  const user = await resolveAuthoritativeAuthUserSnapshot(env, readUserSnapshotFromBody(principal));
  if (!user.id) {
    throw new HttpError(401, "missing_resource_user");
  }

  assertResourceMintAllowedForAuth(body, mintAuth);

  const access = evaluateAppAccess({
    action: "token",
    app: appClientFromResource(resource),
    user
  });

  await recordAuditEvent(env, {
    action: "resource_token_mint_evaluated",
    actorUserId: user.id,
    clientAppId: readOptionalString(body.clientId ?? body.client_id) ?? "workspace-ai-mcp",
    decision: access.decision,
    metadata: {
      audience,
      policyVersion: access.policyVersion,
      reason: access.reason,
      scopes: readStringList(body.scopes),
      toolName: readOptionalString(body.toolName ?? body.tool_name),
      toolAlias: readOptionalString(body.toolAlias ?? body.tool_alias)
    },
    reason: access.reason,
    requestId,
    resourceId: resource.id,
    resourceType: "resource_client"
  });

  if (access.decision !== "allow") {
    throw new HttpError(403, access.reason);
  }

  const scopes = resourceTokenScopes(body.scopes, resource.allowedScopes ?? []);
  const systemRoles = resolveAppSystemRoles(appClientFromResource(resource), user);
  const ttlSeconds = resourceTokenTtlSeconds(env);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const accessToken = await signAuthToken(env, {
    typ: "resource_access",
    iss: issuer(env),
    aud: audience,
    sub: user.id,
    email: user.email,
    jobTitle: "",
    name: user.name,
    role: user.role,
    org_id: env.WORKSPACE_ORG_ID || env.ENTRA_TENANT_ID,
    team: user.team,
    team_id: user.teamId,
    team_path: user.teamPath ?? [],
    department: user.department,
    department_id: user.departmentId,
    department_path: user.departmentPath ?? [],
    client_id: readOptionalString(body.clientId ?? body.client_id) ?? "workspace-ai-mcp",
    mcp_connection_id: readOptionalString(body.connectionId ?? body.connection_id),
    resource_id: resource.id,
    resource_name: resource.name,
    app_role_policy_version: resource.systemRolePolicyVersion,
    app_system_roles: systemRoles,
    tool_name: readOptionalString(body.toolName ?? body.tool_name),
    tool_alias: readOptionalString(body.toolAlias ?? body.tool_alias),
    scopes,
    exp: expiresAt
  });

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ttlSeconds,
    scope: scopes.join(" "),
    resource_id: resource.id,
    audience,
    requestId
  });
}

function assertResourceMintAllowedForAuth(
  body: Record<string, unknown>,
  mintAuth: ResourceMintAuth
) {
  const explicitlyBrokered = body.mcpBrokered === true || body.mcp_brokered === true;
  if (mintAuth === "service" && !explicitlyBrokered) {
    return;
  }

  const clientId = readOptionalString(body.clientId ?? body.client_id) ?? "workspace-ai-mcp";
  if (clientId !== "workspace-ai-mcp") {
    throw new HttpError(403, "resource_mint_client_not_allowed");
  }

  requireText(body.connectionId ?? body.connection_id, "missing_mcp_connection_id", 180);

  // The authenticated Workspace MCP Worker has already verified the self-contained
  // access JWT. Resource policy and allowed scopes are evaluated below, but the
  // mutable connection row is intentionally not part of this request hot path.
}

export async function introspectResourceToken(request: Request, env: Env, requestId: string, appId?: string) {
  const body = await readJson<Record<string, unknown>>(request);
  const token = requireText(body.token, "missing_token", 8192);
  let payload: Record<string, unknown>;

  try {
    payload = await verifyAuthToken(env, token);
  } catch {
    return json({ active: false, requestId });
  }

  if (payload.typ !== "resource_access") {
    return json({ active: false, requestId });
  }

  const requestedAudience = readOptionalString(body.audience);
  const audiences = Array.isArray(payload.aud) ? payload.aud.map(String) : [readString(payload.aud)].filter(Boolean);
  if (requestedAudience && !audiences.includes(requestedAudience)) {
    return json({ active: false, requestId });
  }

  const tokenScopes = readStringList(payload.scopes);
  const missingScopes = readStringList(body.scopes).filter((scope) => !tokenScopes.includes(scope));
  if (missingScopes.length > 0) {
    return json({ active: false, requestId });
  }

  const resourceId = readOptionalString(payload.resource_id);
  if (appId && resourceId !== `app-mcp:${appId}`) {
    return json({ active: false, requestId });
  }
  if (resourceId) {
    const resource = await readResourceClient(env, resourceId);
    if (!resource || resource.status !== "listed") {
      return json({ active: false, requestId });
    }
  }

  return json({
    active: true,
    aud: payload.aud,
    clientId: payload.client_id,
    connectionId: payload.mcp_connection_id,
    exp: payload.exp,
    resourceId,
    scope: tokenScopes.join(" "),
    scopes: tokenScopes,
    sub: payload.sub,
    principal: {
      sub: payload.sub,
      email: payload.email,
      jobTitle: "",
      name: payload.name,
      orgId: payload.org_id,
      role: payload.role,
      team: payload.team,
      teamId: payload.team_id,
      teamPath: readStringList(payload.team_path),
      department: payload.department,
      departmentId: payload.department_id,
      departmentPath: readStringList(payload.department_path),
      scopes: tokenScopes,
      aud: payload.aud,
      clientId: payload.client_id,
      connectionId: payload.mcp_connection_id,
      appId: resourceId,
      appRolePolicyVersion: readOptionalString(payload.app_role_policy_version),
      appSystemRoles: readStringList(payload.app_system_roles)
    },
    requestId
  });
}

function resourceTokenScopes(requestedValue: unknown, allowedScopes: string[]) {
  const requested = readStringList(requestedValue);
  const selected = requested.length > 0 ? requested : allowedScopes;

  if (allowedScopes.length === 0) {
    return Array.from(new Set(selected));
  }

  const allowed = new Set(allowedScopes);
  const invalid = selected.filter((scope) => !allowed.has(scope));
  if (invalid.length > 0) {
    throw new HttpError(403, "resource_scope_not_allowed");
  }

  return Array.from(new Set(selected));
}

export async function requireResourceIntrospectionAccess(request: Request, env: Env) {
  const credentials = basicClientCredentials(request);
  if (credentials?.clientId) {
    const app = await resolveAppClient(env, credentials.clientId);
    await requireAppClientAuthentication(request, env, app.id);
    if (app.status !== "listed" || app.sdkStatus !== "connected") {
      throw new HttpError(403, "app_resource_introspection_not_allowed");
    }
    return app.id;
  }

  const token = bearerToken(request);
  if (env.AUTH_RESOURCE_INTROSPECTION_TOKEN && token === env.AUTH_RESOURCE_INTROSPECTION_TOKEN) {
    return undefined;
  }

  if (serviceTokens(env).includes(token)) {
    return undefined;
  }

  throw new HttpError(401, "invalid_resource_introspection_token");
}
