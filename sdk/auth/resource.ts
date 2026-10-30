import {
  clientBasicAuthHeader,
  WorkspaceAuthSdkError,
  type AccessRequirements,
  type AuthClaims,
  type WorkspaceAuthConfig,
  type IntrospectionResponse,
  normalizeAuthConfig
} from "./types.ts";

type NormalizedConfig = ReturnType<typeof normalizeAuthConfig>;

export class WorkspaceAuthResource {
  private readonly config: NormalizedConfig;

  constructor(config: WorkspaceAuthConfig) {
    this.config = normalizeAuthConfig(config, { requireClientId: false });
  }

  async requireAccess(request: Request, requirements: AccessRequirements = {}): Promise<AuthClaims> {
    const token = bearerToken(request);
    if (!token) {
      throw new WorkspaceAuthSdkError("missing_bearer_token", "Missing Bearer token", 401);
    }

    return this.verifyAccessToken(token, requirements);
  }

  async verifyAccessToken(token: string, requirements: AccessRequirements = {}): Promise<AuthClaims> {
    const result = await this.introspect({ token, ...requirements });

    if (!result.active) {
      throw new WorkspaceAuthSdkError("inactive_token", "Token is inactive", 401);
    }

    const claims = claimsFromIntrospection(result);
    assertAudience(claims, requirements.audience);
    assertResourceId(claims, requirements.resourceId);
    assertScopes(claims.scopes ?? [], requirements.scopes ?? []);

    return claims;
  }

  async introspect(input: { token: string } & AccessRequirements): Promise<IntrospectionResponse> {
    const path = this.config.introspectionPath ?? "/v1/tokens/introspect";
    const response = await this.config.fetcher(`${this.config.authOrigin}${path}`, {
      method: "POST",
      headers: authHeaders(this.config),
      body: JSON.stringify({
        token: input.token,
        audience: input.audience,
        scopes: input.scopes
      })
    });
    const text = await response.text();

    if (!response.ok) {
      throw new WorkspaceAuthSdkError("token_introspection_failed", text || response.statusText, response.status);
    }

    return parseJson<IntrospectionResponse>(text);
  }
}

export function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function authHeaders(config: NormalizedConfig) {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json"
  });

  if (config.introspectionToken) {
    headers.set("Authorization", `Bearer ${config.introspectionToken}`);
  } else if (config.appSecret && config.clientId) {
    headers.set("Authorization", clientBasicAuthHeader(config.clientId, config.appSecret));
  }

  return headers;
}

function claimsFromIntrospection(result: IntrospectionResponse): AuthClaims {
  const principal = isRecord(result.principal) ? result.principal as Partial<AuthClaims> : {};
  const scopes = normalizeScopes(result.scopes ?? result.scope ?? principal.scopes);
  const sub = readOptionalString(principal.sub ?? result.sub);

  if (!sub) {
    throw new WorkspaceAuthSdkError("missing_token_subject", "Token subject is missing", 401);
  }

  return {
    ...principal,
    aud: principal.aud ?? result.aud,
    appId: principal.appId ?? result.resourceId ?? result.resource_id ?? result.appId ?? result.app_id,
    appRolePolicyVersion: readOptionalString(
      principal.appRolePolicyVersion ?? result.appRolePolicyVersion ?? result.app_role_policy_version
    ),
    appSystemRoles: normalizeScopes(
      principal.appSystemRoles ?? result.appSystemRoles ?? result.app_system_roles
    ),
    clientId: principal.clientId ?? result.clientId ?? result.client_id,
    department: principal.department ?? result.department,
    email: principal.email ?? result.email,
    exp: principal.exp ?? result.exp,
    name: principal.name ?? result.name,
    role: principal.role ?? result.role,
    scopes,
    sub,
    team: principal.team ?? result.team,
    raw: result
  };
}

function assertAudience(claims: AuthClaims, audience?: string) {
  if (!audience) {
    return;
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud].filter(Boolean);
  if (!audiences.includes(audience)) {
    throw new WorkspaceAuthSdkError("token_audience_mismatch", "Token audience mismatch", 403);
  }
}

function assertResourceId(claims: AuthClaims, resourceId?: string) {
  if (resourceId && claims.appId !== resourceId) {
    throw new WorkspaceAuthSdkError("token_resource_mismatch", "Token resource mismatch", 403);
  }
}

function assertScopes(actual: string[], required: string[]) {
  const missing = required.filter((scope) => !actual.includes(scope));
  if (missing.length > 0) {
    throw new WorkspaceAuthSdkError("token_scope_missing", `Missing required scopes: ${missing.join(" ")}`, 403);
  }
}

function normalizeScopes(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }

  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJson<T>(text: string): T {
  if (!text.trim()) {
    return {} as T;
  }

  return JSON.parse(text) as T;
}
