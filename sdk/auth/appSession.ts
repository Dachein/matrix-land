import { buildWorkspaceAccessPageUrl } from "./access.ts";
import { WorkspaceAuthServer } from "./server.ts";
import {
  WorkspaceAuthSdkError,
  type AuthUser,
  defaultAgentInfo,
  type WorkspaceAuthFetch
} from "./types.ts";

export const WORKSPACE_APP_SESSION_COOKIE = "__Secure-workspace_app_session";
export const WORKSPACE_APP_AUTH_STATE_COOKIE = "__Secure-workspace_app_auth_state";
export const WORKSPACE_APP_SESSION_VERSION = 1 as const;
/** Stable marker retained in official SDK bundles for APPS Auth preflight. */
export const WORKSPACE_APP_SESSION_INTEGRATION = "workspace-browser-app-session-v1" as const;

const AUTH_STATE_PARAM = "workspace_auth_state";
const DEFAULT_SESSION_TTL_SECONDS = 15 * 60;
const DEFAULT_STATE_TTL_SECONDS = 10 * 60;
const MAX_SESSION_BODY_LENGTH = 3_500;

export type WorkspaceBrowserAppSessionData = {
  appId: string;
  appVersion: string;
  exp: number;
  iat: number;
  user: AuthUser;
  version: typeof WORKSPACE_APP_SESSION_VERSION;
};

export type WorkspaceBrowserAppSessionConfig = {
  appId: string;
  appOrigin: string;
  appSecret: string;
  appVersion: string;
  authOrigin: string;
  authorizeOrigin: string;
  authorizePath?: string;
  basePath?: string;
  crypto?: Crypto;
  fetcher?: WorkspaceAuthFetch;
  now?: () => number;
  sessionSecret: string;
  sessionTtlSeconds?: number;
  stateTtlSeconds?: number;
};

export type WorkspaceBrowserAppSessionStartOptions = {
  returnTo?: string | URL;
};

type NormalizedConfig = {
  appId: string;
  appOrigin: string;
  appSecret: string;
  appVersion: string;
  authOrigin: string;
  authorizeOrigin: string;
  authorizePath: string;
  basePath: string;
  crypto: Crypto;
  fetcher?: WorkspaceAuthFetch;
  now: () => number;
  sessionSecret: string;
  sessionTtlSeconds: number;
  stateTtlSeconds: number;
};

/**
 * Browser login and local session boundary for Workspace Apps.
 *
 * This helper deliberately reads identity only from a Workspace Auth one-time-code
 * exchange or from its own signed cookie. Request identity headers, including
 * every x-workspace-* header, are never consulted.
 */
export class WorkspaceBrowserAppSession {
  private readonly auth: WorkspaceAuthServer;
  private readonly config: NormalizedConfig;

  constructor(config: WorkspaceBrowserAppSessionConfig) {
    // Keep the official integration marker in production bundles that use this class.
    void WORKSPACE_APP_SESSION_INTEGRATION;
    this.config = normalizeConfig(config);
    this.auth = new WorkspaceAuthServer({
      appSecret: this.config.appSecret,
      authOrigin: this.config.authOrigin,
      clientId: this.config.appId,
      fetcher: this.config.fetcher
    });
  }

  /** Redirects the browser to Workspace Auth and binds the attempt to an HttpOnly state cookie. */
  start(request: Request, options: WorkspaceBrowserAppSessionStartOptions = {}) {
    const requestUrl = this.requireRequestUrl(request, this.startPath());
    const returnTo = safeAppUrl(
      options.returnTo ?? requestUrl.searchParams.get("return_to"),
      this.config.appOrigin,
      this.config.basePath
    );
    const state = randomState(this.config.crypto);
    returnTo.searchParams.set(AUTH_STATE_PARAM, state);

    const authorize = new URL(this.config.authorizePath, this.config.authorizeOrigin);
    authorize.searchParams.set("app_id", this.config.appId);
    authorize.searchParams.set("redirect_uri", this.callbackUrl());
    authorize.searchParams.set("redirect_url", returnTo.toString());

    return redirect(authorize.toString(), {
      "Set-Cookie": stateCookie(state, this.config)
    });
  }

  /**
   * Exchanges a browser-bound, one-time launch code and creates the App's own
   * signed session. Legacy direct-jump tokens are never accepted as sessions.
   */
  async callback(request: Request): Promise<Response> {
    this.requireRequestUrl(request, this.callbackPath());
    const params = this.auth.readLaunchParams(request);

    if (params.token) {
      return this.restartCodeFlow(params.redirectUrl);
    }
    if (params.appId && params.appId !== this.config.appId) {
      throw sdkError("auth_app_mismatch", 401);
    }

    const expectedState = cookieValue(request, WORKSPACE_APP_AUTH_STATE_COOKIE);
    if (!expectedState) {
      throw sdkError("auth_state_missing", 401);
    }

    const callbackRedirect = requireBoundRedirect(
      params.redirectUrl,
      expectedState,
      this.config.appOrigin,
      this.config.basePath
    );
    if (params.error) {
      if (params.error !== "access_denied" || !params.accessResult) {
        throw sdkError("invalid_auth_error_callback", 401);
      }
      return this.accessDeniedRedirect(params.accessResult);
    }
    if (!params.code) {
      throw sdkError("missing_launch_code", 401);
    }

    let login;
    try {
      login = await this.auth.exchangeLaunch({
        appId: this.config.appId,
        code: params.code,
        redirectUri: this.callbackUrl()
      });
    } catch (error) {
      if (
        error instanceof WorkspaceAuthSdkError
        && error.status === 403
        && typeof error.details?.accessResult === "string"
      ) {
        return this.accessDeniedRedirect(error.details.accessResult);
      }
      if (
        error instanceof WorkspaceAuthSdkError
        && (error.code === "missing_auth_user" || error.code === "missing_auth_user_id")
      ) {
        throw sdkError(error.code, 401);
      }
      throw error;
    }

    if (!login.valid || login.appId !== this.config.appId) {
      throw sdkError("invalid_auth_login", 401);
    }
    const user = normalizeUser(login.user);
    const authoritativeRedirect = requireBoundRedirect(
      login.redirectUrl,
      expectedState,
      this.config.appOrigin,
      this.config.basePath
    );
    if (authoritativeRedirect.toString() !== callbackRedirect.toString()) {
      throw sdkError("auth_redirect_mismatch", 401);
    }

    authoritativeRedirect.searchParams.delete(AUTH_STATE_PARAM);
    const token = await this.createToken(user);
    const headers = new Headers({ Location: authoritativeRedirect.toString() });
    headers.append("Set-Cookie", sessionCookie(token, this.config));
    headers.append("Set-Cookie", clearStateCookie(this.config));
    return redirect(authoritativeRedirect.toString(), headers);
  }

  /** Returns only a valid local App cookie session; request identity headers are ignored. */
  async read(request: Request): Promise<WorkspaceBrowserAppSessionData | undefined> {
    const requestUrl = new URL(request.url);
    if (requestUrl.origin !== this.config.appOrigin || !pathWithinBase(requestUrl.pathname, this.config.basePath)) {
      return undefined;
    }
    if (!isSafeMethod(request.method) && request.headers.get("origin") !== this.config.appOrigin) {
      throw sdkError("app_csrf_origin_mismatch", 403);
    }
    const token = cookieValue(request, WORKSPACE_APP_SESSION_COOKIE);
    if (!token) {
      return undefined;
    }
    return this.verifyToken(token);
  }

  async require(request: Request): Promise<WorkspaceBrowserAppSessionData> {
    const session = await this.read(request);
    if (!session) {
      throw sdkError("missing_app_session", 401);
    }
    return session;
  }

  logout() {
    const headers = new Headers();
    headers.append("Set-Cookie", clearSessionCookie(this.config));
    headers.append("Set-Cookie", clearStateCookie(this.config));
    return redirect(this.signedOutUrl(), headers);
  }

  private accessDeniedRedirect(accessResult: string) {
    const headers = new Headers();
    headers.append("Set-Cookie", clearStateCookie(this.config));
    return redirect(buildWorkspaceAccessPageUrl(this.config.authorizeOrigin, accessResult), headers);
  }

  private async createToken(user: AuthUser) {
    const iat = Math.floor(this.config.now() / 1000);
    const payload: WorkspaceBrowserAppSessionData = {
      appId: this.config.appId,
      appVersion: this.config.appVersion,
      exp: iat + this.config.sessionTtlSeconds,
      iat,
      user,
      version: WORKSPACE_APP_SESSION_VERSION
    };
    const body = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
    if (body.length > MAX_SESSION_BODY_LENGTH) {
      throw sdkError("app_session_too_large", 503);
    }
    const signature = await sign(body, this.config.sessionSecret, this.config.crypto);
    return `${body}.${base64Url(signature)}`;
  }

  private async verifyToken(token: string): Promise<WorkspaceBrowserAppSessionData | undefined> {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra || body.length > MAX_SESSION_BODY_LENGTH || signature.length > 200) {
      return undefined;
    }

    try {
      const key = await hmacKey(this.config.sessionSecret, this.config.crypto, ["verify"]);
      const valid = await this.config.crypto.subtle.verify(
        "HMAC",
        key,
        fromBase64Url(signature),
        new TextEncoder().encode(body)
      );
      if (!valid) {
        return undefined;
      }

      const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as Partial<WorkspaceBrowserAppSessionData>;
      const now = Math.floor(this.config.now() / 1000);
      if (
        payload.version !== WORKSPACE_APP_SESSION_VERSION
        || payload.appId !== this.config.appId
        || payload.appVersion !== this.config.appVersion
        || !Number.isInteger(payload.iat)
        || !Number.isInteger(payload.exp)
        || payload.iat! > now + 60
        || payload.exp! <= now
        || payload.exp! <= payload.iat!
        || payload.exp! - payload.iat! !== this.config.sessionTtlSeconds
      ) {
        return undefined;
      }

      return {
        appId: payload.appId,
        appVersion: payload.appVersion,
        exp: payload.exp!,
        iat: payload.iat!,
        user: normalizeUser(payload.user),
        version: WORKSPACE_APP_SESSION_VERSION
      };
    } catch {
      return undefined;
    }
  }

  private restartCodeFlow(redirectUrl?: string) {
    const returnTo = safeAppUrl(redirectUrl, this.config.appOrigin, this.config.basePath);
    returnTo.searchParams.delete(AUTH_STATE_PARAM);
    const start = new URL(this.startPath(), this.config.appOrigin);
    start.searchParams.set("return_to", `${returnTo.pathname}${returnTo.search}${returnTo.hash}`);
    return redirect(start.toString());
  }

  private requireRequestUrl(request: Request, expectedPath: string) {
    const url = new URL(request.url);
    if (url.origin !== this.config.appOrigin) {
      throw sdkError("app_request_origin_mismatch", 400);
    }
    if (url.pathname !== expectedPath) {
      throw sdkError("app_auth_path_mismatch", 404);
    }
    return url;
  }

  private callbackUrl() {
    return new URL(this.callbackPath(), this.config.appOrigin).toString();
  }

  private appHomeUrl() {
    return new URL(`${this.config.basePath}/`, this.config.appOrigin).toString();
  }

  private signedOutUrl() {
    return new URL(`${this.config.basePath}/auth/workspace/signed-out`, this.config.appOrigin).toString();
  }

  private callbackPath() {
    return `${this.config.basePath}/auth/workspace/callback`;
  }

  private startPath() {
    return `${this.config.basePath}/auth/workspace/start`;
  }
}

function normalizeConfig(config: WorkspaceBrowserAppSessionConfig): NormalizedConfig {
  const appId = requiredText(config.appId, "missing_app_id");
  const appSecret = requiredText(config.appSecret, "missing_app_secret");
  if (appSecret.length < 32) {
    throw sdkError("weak_app_secret", 503);
  }
  const appVersion = requiredText(config.appVersion, "missing_app_version");
  const sessionSecret = typeof config.sessionSecret === "string" ? config.sessionSecret : "";
  if (sessionSecret.length < 32 || !sessionSecret.trim()) {
    throw sdkError("weak_session_secret", 503);
  }

  const appOrigin = requireAppOrigin(config.appOrigin);
  const authOrigin = requireHttpsOrigin(config.authOrigin, "invalid_auth_origin");
  const authorizeOrigin = requireHttpsOrigin(config.authorizeOrigin, "invalid_authorize_origin");
  const authorizePath = normalizeRoutePath(config.authorizePath ?? "/auth/v1/authorize", "invalid_authorize_path");
  const basePath = normalizeBasePath(config.basePath);

  return {
    appId,
    appOrigin,
    appSecret,
    appVersion,
    authOrigin,
    authorizeOrigin,
    authorizePath,
    basePath,
    crypto: config.crypto ?? crypto,
    fetcher: config.fetcher,
    now: config.now ?? Date.now,
    sessionSecret,
    sessionTtlSeconds: boundedTtl(config.sessionTtlSeconds, DEFAULT_SESSION_TTL_SECONDS, 300, 900, "invalid_session_ttl"),
    stateTtlSeconds: boundedTtl(config.stateTtlSeconds, DEFAULT_STATE_TTL_SECONDS, 60, 1_800, "invalid_state_ttl")
  };
}

function normalizeUser(value: unknown): AuthUser {
  if (!isRecord(value)) {
    throw sdkError("missing_auth_user", 401);
  }
  const id = text(value.id, 240);
  if (!id) {
    throw sdkError("missing_auth_user_id", 401);
  }

  return {
    ...(value.defaultAgent !== undefined ? { defaultAgent: defaultAgentInfo(value.defaultAgent) } : {}),
    department: optionalText(value.department, 240),
    departmentId: optionalText(value.departmentId, 240),
    departmentPath: optionalTextList(value.departmentPath, 32, 240),
    email: optionalText(value.email, 320),
    identityProvider: optionalText(value.identityProvider, 120),
    jobTitle: optionalText(value.jobTitle, 240),
    id,
    name: optionalText(value.name, 240),
    providerSubject: optionalText(value.providerSubject, 240),
    role: optionalText(value.role, 80),
    source: optionalText(value.source, 120),
    status: optionalText(value.status, 80),
    team: optionalText(value.team, 240),
    teamId: optionalText(value.teamId, 240),
    teamPath: optionalTextList(value.teamPath, 32, 240)
  };
}

function requireBoundRedirect(value: string | undefined, state: string, origin: string, basePath: string) {
  if (!value) {
    throw sdkError("auth_state_mismatch", 401);
  }
  try {
    const url = new URL(value);
    if (
      url.origin !== origin
      || !pathWithinBase(url.pathname, basePath)
      || url.searchParams.get(AUTH_STATE_PARAM) !== state
    ) {
      throw sdkError("auth_state_mismatch", 401);
    }
    return url;
  } catch (error) {
    if (error instanceof WorkspaceAuthSdkError) {
      throw error;
    }
    throw sdkError("auth_state_mismatch", 401);
  }
}

function safeAppUrl(value: string | URL | null | undefined, origin: string, basePath: string) {
  const fallback = new URL(`${basePath}/`, origin);
  if (!value) {
    return fallback;
  }
  const raw = value instanceof URL ? value.toString() : value;
  if (raw.startsWith("//") || raw.includes("\\")) {
    return fallback;
  }
  try {
    const url = new URL(raw, origin);
    return url.origin === origin && pathWithinBase(url.pathname, basePath) ? url : fallback;
  } catch {
    return fallback;
  }
}

function cookieValue(request: Request, name: string) {
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key !== name) {
      continue;
    }
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sessionCookie(token: string, config: NormalizedConfig) {
  return `${WORKSPACE_APP_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=${cookiePath(config.basePath)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${config.sessionTtlSeconds}`;
}

function stateCookie(state: string, config: NormalizedConfig) {
  return `${WORKSPACE_APP_AUTH_STATE_COOKIE}=${encodeURIComponent(state)}; Path=${cookiePath(config.basePath)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${config.stateTtlSeconds}`;
}

function clearStateCookie(config: NormalizedConfig) {
  return `${WORKSPACE_APP_AUTH_STATE_COOKIE}=; Path=${cookiePath(config.basePath)}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function clearSessionCookie(config: NormalizedConfig) {
  return `${WORKSPACE_APP_SESSION_COOKIE}=; Path=${cookiePath(config.basePath)}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function cookiePath(basePath: string) {
  return `${basePath}/`;
}

function redirect(location: string, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("Location", location);
  responseHeaders.set("Referrer-Policy", "no-referrer");
  return new Response(null, { headers: responseHeaders, status: 302 });
}

async function sign(body: string, secret: string, cryptoImpl: Crypto) {
  const key = await hmacKey(secret, cryptoImpl, ["sign"]);
  return new Uint8Array(await cryptoImpl.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

function hmacKey(secret: string, cryptoImpl: Crypto, usages: KeyUsage[]) {
  return cryptoImpl.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    usages
  );
}

function randomState(cryptoImpl: Crypto) {
  return base64Url(cryptoImpl.getRandomValues(new Uint8Array(32)));
}

function base64Url(value: Uint8Array) {
  let binary = "";
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid_base64url");
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function normalizeBasePath(value?: string) {
  const path = value?.trim() ?? "";
  if (!path || path === "/") {
    return "";
  }
  if (!path.startsWith("/") || path.startsWith("//") || path.endsWith("/") || path.includes("\\") || path.includes("?") || path.includes("#")) {
    throw sdkError("invalid_base_path", 503);
  }
  const normalized = new URL(path, "https://base.invalid").pathname;
  if (normalized !== path) {
    throw sdkError("invalid_base_path", 503);
  }
  return path;
}

function normalizeRoutePath(value: string, code: string) {
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("?") || path.includes("#")) {
    throw sdkError(code, 503);
  }
  return path;
}

function requireHttpsOrigin(value: string, code: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(code);
    }
    return url.origin;
  } catch {
    throw sdkError(code, 503);
  }
}

function requireAppOrigin(value: string) {
  try {
    const url = new URL(value.trim());
    const local = url.hostname === "localhost"
      || url.hostname === "127.0.0.1"
      || url.hostname === "[::1]";
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("invalid_app_origin");
    }
    return url.origin;
  } catch {
    throw sdkError("invalid_app_origin", 503);
  }
}

function pathWithinBase(pathname: string, basePath: string) {
  return basePath ? pathname === basePath || pathname.startsWith(`${basePath}/`) : pathname.startsWith("/");
}

function isSafeMethod(method: string) {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function boundedTtl(value: number | undefined, fallback: number, min: number, max: number, code: string) {
  const ttl = value ?? fallback;
  if (!Number.isInteger(ttl) || ttl < min || ttl > max) {
    throw sdkError(code, 503);
  }
  return ttl;
}

function requiredText(value: unknown, code: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw sdkError(code, 503);
  }
  return normalized;
}

function optionalText(value: unknown, maxLength: number) {
  return text(value, maxLength) || undefined;
}

function optionalTextList(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.slice(0, maxItems).map((item) => text(item, maxLength)).filter(Boolean);
  return items.length ? items : undefined;
}

function text(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sdkError(code: string, status: number) {
  return new WorkspaceAuthSdkError(code, code, status);
}
