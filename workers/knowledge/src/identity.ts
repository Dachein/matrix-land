import type { Env, Principal } from "./types.ts";
import { HttpError, bearerToken } from "./http.ts";
import { readString, readOptionalString, readStringList, isRecord } from "./values.ts";
import { assertLocalDevRequest, authWorkerUrl, knowledgeAudience, configuredKnowledgeOrgId } from "./configuration.ts";

const INTERACTIVE_KNOWLEDGE_SCOPES = ["workspace:knowledge:read", "workspace:knowledge:write", "workspace:knowledge:share"];

// Resolve identity only. Object-level ACL and folder-edit restrictions remain
// in the request permission boundary before any mutation is allowed.
export async function resolveUnrestrictedPrincipal(request: Request, env: Env): Promise<Principal> {
  if (env.DEV_AUTH_BYPASS === "1") {
    assertLocalDevRequest(request);
    return withBreakGlassReason({
      department: request.headers.get("x-workspace-department") ?? "AI Adoption",
      departmentId: request.headers.get("x-workspace-department-id") ?? "dept-ai-adoption",
      departmentPath: [request.headers.get("x-workspace-department-id") ?? "dept-ai-adoption"],
      email: request.headers.get("x-workspace-user-email") ?? "local.admin@example.invalid",
      name: request.headers.get("x-workspace-user-name") ?? "Local Admin",
      orgId: request.headers.get("x-workspace-org-id") ?? configuredKnowledgeOrgId(env),
      role: request.headers.get("x-workspace-role") ?? "admin",
      scopes: (request.headers.get("x-workspace-scopes") ?? "workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share,workspace:knowledge:admin").split(",").map((scope) => scope.trim()).filter(Boolean),
      sub: request.headers.get("x-workspace-user-id") ?? "local-dev-admin",
      team: request.headers.get("x-workspace-team-name") ?? "AI Adoption",
      teamId: request.headers.get("x-workspace-team-id") ?? "team-ai-adoption"
    }, request);
  }

  const bearer = bearerToken(request);
  if (bearer) {
    return withBreakGlassReason(await introspectResourceToken(env, bearer), request);
  }

  const session = await readAuthSession(request, env);
  if (session) {
    return withBreakGlassReason(session, request);
  }

  throw new HttpError(401, "not_authenticated");
}

export function withBreakGlassReason(principal: Principal, request: Request): Principal {
  if (principal.role !== "admin" || !principal.scopes.includes("workspace:knowledge:admin")) {
    return principal;
  }
  const reason = request.headers.get("x-workspace-break-glass-reason")?.trim() ?? "";
  if (!reason) {
    return principal;
  }
  if (reason.length < 8 || reason.length > 500 || /[\u0000-\u001f]/.test(reason)) {
    throw new HttpError(400, "invalid_knowledge_break_glass_reason");
  }
  return { ...principal, breakGlassReason: reason };
}

export async function readAuthSession(request: Request, env: Env): Promise<Principal | undefined> {
  const base = authWorkerUrl(env);
  const headers = new Headers({ Accept: "application/json" });
  const cookie = request.headers.get("cookie");
  if (!cookie) {
    return undefined;
  }
  headers.set("cookie", cookie);
  const response = await fetch(`${base}/auth/session`, { headers });
  if (!response.ok) {
    return undefined;
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (payload.authenticated !== true || !isRecord(payload.user)) {
    return undefined;
  }
  return principalFromUser(payload.user, INTERACTIVE_KNOWLEDGE_SCOPES, configuredKnowledgeOrgId(env));
}

export async function introspectResourceToken(env: Env, token: string): Promise<Principal> {
  const introspectionToken = env.AUTH_RESOURCE_INTROSPECTION_TOKEN?.trim() || env.AUTH_SERVICE_TOKEN?.trim();
  if (!introspectionToken) {
    throw new HttpError(503, "resource_introspection_token_not_configured");
  }
  const response = await fetch(`${authWorkerUrl(env)}/v1/tokens/introspect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${introspectionToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      token,
      audience: knowledgeAudience(env)
    })
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || payload.active !== true) {
    throw new HttpError(401, "resource_token_inactive");
  }
  const principal = isRecord(payload.principal) ? payload.principal : payload;
  return principalFromUser({
    ...principal,
    id: principal.sub ?? principal.id,
    departmentPath: principal.department_path ?? principal.departmentPath,
    teamId: principal.team_id ?? principal.teamId,
    departmentId: principal.department_id ?? principal.departmentId,
    orgId: principal.org_id ?? principal.orgId ?? principal.organization_id ?? principal.organizationId
  }, [], configuredKnowledgeOrgId(env));
}

export function principalFromUser(user: Record<string, unknown>, fallbackScopes: string[] = [], fallbackOrgId = ""): Principal {
  const id = readString(user.id ?? user.sub ?? user.userId);
  if (!id) {
    throw new HttpError(401, "invalid_principal");
  }
  const scopes = readStringList(user.scopes);
  const identity = isRecord(user.identity) ? user.identity : {};
  const orgId = readString(
    user.orgId
      ?? user.org_id
      ?? user.organizationId
      ?? user.organization_id
      ?? fallbackOrgId
      ?? identity.orgId
      ?? identity.org_id
      ?? identity.tenantId
      ?? identity.tenant_id
  ).trim();
  if (!orgId) {
    throw new HttpError(401, "invalid_principal_org");
  }
  return {
    clientId: readOptionalString(user.clientId ?? user.client_id),
    connectionId: readOptionalString(
      user.connectionId
      ?? user.connection_id
      ?? user.mcpConnectionId
      ?? user.mcp_connection_id
    ),
    department: readOptionalString(user.department),
    departmentId: readOptionalString(user.departmentId),
    departmentPath: readStringList(user.departmentPath),
    email: readOptionalString(user.email),
    name: readOptionalString(user.name) ?? readOptionalString(user.email) ?? id,
    orgId,
    role: readOptionalString(user.role) ?? "member",
    scopes: scopes.length > 0 ? scopes : fallbackScopes,
    sub: id,
    team: readOptionalString(user.team),
    teamId: readOptionalString(user.teamId)
  };
}

export function requiredKnowledgeActorEmail(principal: Principal) {
  const email = principal.email?.trim().toLowerCase() ?? "";
  if (!email || email.length > 320 || /[\u0000-\u0020\u007f]/.test(email)) {
    throw new HttpError(401, "invalid_principal_email");
  }
  return email;
}
