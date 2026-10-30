import {
  clientBasicAuthHeader,
  defaultAgentInfo,
  WorkspaceAuthSdkError,
  type AuthClaims,
  type WorkspaceAuthConfig,
  type LaunchExchangeInput,
  type LaunchExchangeResponse,
  normalizeAuthConfig
} from "./types.ts";

type NormalizedConfig = ReturnType<typeof normalizeAuthConfig>;

export type LaunchCallbackParams = {
  accessResult?: string;
  appId?: string;
  code?: string;
  error?: string;
  requestId?: string;
  redirectUrl?: string;
  token?: string;
};

export class WorkspaceAuthServer {
  private readonly config: NormalizedConfig;

  constructor(config: WorkspaceAuthConfig) {
    this.config = normalizeAuthConfig(config);
  }

  readLaunchParams(input: Request | URL | string): LaunchCallbackParams {
    const url = input instanceof Request
      ? new URL(input.url)
      : input instanceof URL
        ? input
        : new URL(input);

    return {
      accessResult: readOptionalParam(url, "access_result"),
      appId: readOptionalParam(url, "app_id") ?? readOptionalParam(url, "client_id"),
      code: readOptionalParam(url, "code"),
      error: readOptionalParam(url, "error"),
      requestId: readOptionalParam(url, "request_id"),
      redirectUrl: readOptionalParam(url, "redirect_url"),
      token: readOptionalParam(url, "workspace_token") ?? readOptionalParam(url, "token")
    };
  }

  async exchangeLaunch(input: LaunchExchangeInput): Promise<LaunchExchangeResponse> {
    if (!input.code && input.token) {
      return this.verifyLaunchToken(input.token, input.clientId ?? input.appId ?? this.config.clientId);
    }

    if (!input.code) {
      throw new WorkspaceAuthSdkError("missing_launch_code");
    }

    const appId = input.clientId ?? input.appId ?? this.config.clientId;
    const payload = await this.post<Record<string, unknown>>("/v1/app-login/exchange", {
      appId,
      clientId: appId,
      code: input.code,
      redirectUri: input.redirectUri
    });

    return normalizeLaunchExchange(payload, appId);
  }

  async verifyLaunchToken(token: string, appId = this.config.clientId): Promise<LaunchExchangeResponse> {
    const payload = await this.post<Record<string, unknown>>("/v1/app-login/verify", {
      appId,
      token
    });

    return normalizeLaunchExchange(payload, appId);
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.config.fetcher(`${this.config.authOrigin}${path}`, {
      method: "POST",
      headers: authHeaders(this.config),
      body: JSON.stringify(body)
    });
    const text = await response.text();

    if (!response.ok) {
      const details = parseErrorDetails(text);
      throw new WorkspaceAuthSdkError(
        "auth_worker_request_failed",
        readOptionalString(details?.message) ?? readOptionalString(details?.error) ?? response.statusText,
        response.status,
        details
      );
    }

    return parseJson<T>(text);
  }
}

function parseErrorDetails(text: string) {
  if (!text.trim()) {
    return undefined;
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function claimsFromLaunch(response: LaunchExchangeResponse): AuthClaims {
  return {
    aud: response.appId,
    sub: response.user.id,
    defaultAgent: defaultAgentInfo(response.user.defaultAgent),
    appId: response.appId,
    clientId: response.appId,
    email: response.user.email,
    name: response.user.name,
    role: response.user.role,
    team: response.user.team,
    teamId: response.user.teamId,
    teamPath: response.user.teamPath,
    department: response.user.department,
    departmentId: response.user.departmentId,
    departmentPath: response.user.departmentPath,
    exp: response.expiresAt,
    raw: {
      redirectUrl: response.redirectUrl,
      requestId: response.requestId
    }
  };
}

function authHeaders(config: NormalizedConfig) {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json"
  });

  if (config.appSecret) {
    headers.set("Authorization", clientBasicAuthHeader(config.clientId, config.appSecret));
  }

  return headers;
}

function normalizeLaunchExchange(payload: Record<string, unknown>, appId: string): LaunchExchangeResponse {
  const user = payload.user;
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    throw new WorkspaceAuthSdkError("missing_auth_user");
  }

  const normalizedUser = user as LaunchExchangeResponse["user"];
  if (!normalizedUser.id) {
    throw new WorkspaceAuthSdkError("missing_auth_user_id");
  }

  const response: LaunchExchangeResponse = {
    valid: payload.valid === true,
    appId: readString(payload.appId) || appId,
    expiresAt: readNumber(payload.expiresAt),
    idToken: readOptionalString(payload.id_token ?? payload.idToken),
    redirectUrl: readOptionalString(payload.redirectUrl ?? payload.redirect_url),
    requestId: readOptionalString(payload.requestId),
    tokenType: readOptionalString(payload.tokenType ?? payload.token_type),
    user: normalizedUser
  };
  response.claims = claimsFromLaunch(response);

  return response;
}

function readOptionalParam(url: URL, name: string) {
  return readOptionalString(url.searchParams.get(name));
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text || undefined;
}

function readNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseJson<T>(text: string): T {
  if (!text.trim()) {
    return {} as T;
  }

  return JSON.parse(text) as T;
}
