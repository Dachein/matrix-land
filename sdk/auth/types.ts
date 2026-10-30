export type WorkspaceAuthFetch = typeof fetch;

export type WorkspaceAuthConfig = {
  authOrigin: string;
  appId?: string;
  clientId?: string;
  appSecret?: string;
  fetcher?: WorkspaceAuthFetch;
  introspectionToken?: string;
  introspectionPath?: string;
};

export type DefaultAgentInfo = { id: string; name: string; email: string };

export function defaultAgentInfo(value: unknown): DefaultAgentInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ([record.id, record.name, record.email].some(item => typeof item !== "string" || !item.trim())) return null;
  return { id: String(record.id), name: String(record.name), email: String(record.email) };
}

export type AuthUser = {
  defaultAgent?: DefaultAgentInfo | null;
  id: string;
  departmentId?: string;
  departmentPath?: string[];
  email?: string;
  identityProvider?: string;
  jobTitle?: string;
  name?: string;
  providerSubject?: string;
  role?: string;
  source?: string;
  teamId?: string;
  teamPath?: string[];
  team?: string;
  department?: string;
  status?: string;
};

export type AuthClaims = {
  defaultAgent?: DefaultAgentInfo | null;
  iss?: string;
  aud?: string | string[];
  sub: string;
  appId?: string;
  appRolePolicyVersion?: string;
  appSystemRoles?: string[];
  clientId?: string;
  email?: string;
  name?: string;
  role?: string;
  team?: string;
  teamId?: string;
  teamPath?: string[];
  department?: string;
  departmentId?: string;
  departmentPath?: string[];
  scopes?: string[];
  exp?: number;
  iat?: number;
  jti?: string;
  raw?: Record<string, unknown>;
};

export type TokenResponse = {
  accessToken?: string;
  idToken?: string;
  tokenType?: "Bearer" | string;
  expiresAt?: number;
  expiresIn?: number;
  scope?: string;
  scopes?: string[];
  claims?: AuthClaims;
  user?: AuthUser;
};

export type LaunchExchangeInput = {
  code?: string;
  clientId?: string;
  token?: string;
  appId?: string;
  redirectUri?: string;
};

export type LaunchExchangeResponse = TokenResponse & {
  valid: boolean;
  appId: string;
  redirectUrl?: string;
  requestId?: string;
  user: AuthUser;
};

export type AccessRequirements = {
  audience?: string;
  resourceId?: string;
  scopes?: string[];
};

export type IntrospectionResponse = {
  active: boolean;
  aud?: string | string[];
  clientId?: string;
  client_id?: string;
  appId?: string;
  app_id?: string;
  appRolePolicyVersion?: string;
  app_role_policy_version?: string;
  appSystemRoles?: string[];
  app_system_roles?: string[];
  exp?: number;
  sub?: string;
  email?: string;
  name?: string;
  role?: string;
  resourceId?: string;
  resource_id?: string;
  team?: string;
  department?: string;
  scope?: string;
  scopes?: string[];
  principal?: AuthClaims;
  requestId?: string;
  [key: string]: unknown;
};

export class WorkspaceAuthSdkError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly status?: number;

  constructor(
    code: string,
    message = code,
    status?: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "WorkspaceAuthSdkError";
    this.status = status;
  }
}

export type NormalizeAuthConfigOptions = {
  requireClientId?: boolean;
};

export function normalizeAuthConfig(config: WorkspaceAuthConfig, options: NormalizeAuthConfigOptions = {}) {
  const authOrigin = config.authOrigin.trim().replace(/\/+$/, "");
  const clientId = (config.clientId ?? config.appId ?? "").trim();
  const requireClientId = options.requireClientId ?? true;

  if (!authOrigin) {
    throw new WorkspaceAuthSdkError("missing_auth_origin");
  }

  if (requireClientId && !clientId) {
    throw new WorkspaceAuthSdkError("missing_client_id");
  }

  return {
    ...config,
    authOrigin,
    clientId,
    fetcher: config.fetcher ?? ((input, init) => fetch(input, init))
  };
}

export function clientBasicAuthHeader(clientId: string, appSecret: string) {
  return `Basic ${base64Encode(`${clientId}:${appSecret}`)}`;
}

function base64Encode(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}
