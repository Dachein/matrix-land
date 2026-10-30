import type { PortalCatalog } from "../../../src/shared/types.ts";

type CurrentUser = PortalCatalog["currentUser"];

type AuthBoundaryEnv = {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  DB?: D1Database;
};

type AuthBoundaryContext<TEnv extends AuthBoundaryEnv> = EventContext<TEnv, string, unknown>;

type AuthBoundaryDeps<TEnv extends AuthBoundaryEnv> = {
  audit(
    db: D1Database | undefined,
    actorType: string,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>
  ): Promise<string>;
  fetch?: typeof fetch;
  httpError(status: number, message: string): Error;
  readBody<T>(request: Request): Promise<T>;
  requireDb(db: D1Database | undefined): D1Database;
  requireText(value: unknown, errorCode: string, maxLength: number): string;
  resolveCurrentUser(context: AuthBoundaryContext<TEnv>): Promise<CurrentUser>;
};

type LaunchableApp = {
  accessMode: string;
  accessTargetsJson: string;
  businessOwnerUserId: string | null;
  callbackUrl: string;
  id: string;
  launchUrl: string;
  name: string;
  publisherUserId: string | null;
  sdkStatus: string;
  status: string;
};

type DirectJumpBody = {
  appId?: string;
  redirectUrl?: string;
};

type AuditBody = {
  action?: string;
  actorId?: string;
  actorType?: string;
  clientAppId?: string;
  decision?: string;
  metadata?: Record<string, unknown>;
  reason?: string;
  resourceId?: string;
  resourceType?: string;
  targetId?: string;
  targetType?: string;
};

type ApiKeyBody = {
  scopes?: string[];
  subjectId?: string;
  subjectType?: string;
};

export function createAuthBoundaryApi<TEnv extends AuthBoundaryEnv>(deps: AuthBoundaryDeps<TEnv>) {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));

  return {
    async createDirectJumpToken(context: AuthBoundaryContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<DirectJumpBody>(context.request);
      const appId = deps.requireText(body.appId, "missing_app_id", 160);
      const app = await loadLaunchableApp(db, appId, deps);
      const authBody: Record<string, unknown> = {
        appId: app.id,
        redirectUrl: body.redirectUrl
      };
      const headers = authWorkerHeaders(currentUser, context);
      headers.set("Authorization", `Bearer ${requireServiceToken(context.env, deps)}`);

      const payload = await authWorkerJson<Record<string, unknown>, TEnv>(context.env, "/v1/app-login/direct-jump", {
        body: authBody,
        errorCode: "auth_worker_direct_jump_failed",
        fetchImpl,
        headers,
        method: "POST"
      }, deps);

      await deps.audit(db, "user", currentUser.id, "issued direct jump token", "app", app.id, {
        authWorker: true,
        expiresAt: payload.expiresAt,
        redirectUrl: payload.redirectUrl
      });

      return payload;
    },

    async verifyDirectJumpToken(context: AuthBoundaryContext<TEnv>) {
      const body = await deps.readBody<{ appId?: string; token?: string }>(context.request);
      const token = deps.requireText(body.token, "missing_direct_jump_token", 4096);
      const payload = await authWorkerJson<Record<string, unknown>, TEnv>(context.env, "/v1/app-login/verify", {
        body: {
          appId: body.appId,
          token
        },
        errorCode: "auth_worker_verify_direct_jump_failed",
        fetchImpl,
        method: "POST"
      }, deps);

      return payload;
    },

    async issueApiKey(context: AuthBoundaryContext<TEnv>) {
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<ApiKeyBody>(context.request);
      const hasCustomSubject = Boolean(readOptionalString(body.subjectType) || readOptionalString(body.subjectId));

      if (hasCustomSubject && currentUser.role !== "admin") {
        throw deps.httpError(403, "admin_required");
      }

      const subjectType = hasCustomSubject
        ? normalizeApiKeySubjectType(body.subjectType, deps)
        : "user";
      const subjectId = hasCustomSubject
        ? deps.requireText(body.subjectId, "missing_subject_id", 240)
        : currentUser.id;
      const rawKey = `workspace_${crypto.randomUUID().replaceAll("-", "")}_${crypto.randomUUID().replaceAll("-", "")}`;
      const tokenHash = await sha256(rawKey);
      const tokenId = crypto.randomUUID();
      const db = context.env.DB;
      const scopes = sanitizeApiKeyScopes(body.scopes);

      if (db) {
        await db
          .prepare(
            `
            INSERT INTO access_tokens (id, subject_type, subject_id, token_kind, token_hash, scopes_json)
            VALUES (?, ?, ?, 'api_key', ?, ?)
            `
          )
          .bind(tokenId, subjectType, subjectId, tokenHash, JSON.stringify(scopes))
          .run();
      }

      await deps.audit(db, "user", currentUser.id, "issued api key", "access_token", tokenId, {
        scopes,
        subjectId,
        subjectType
      });

      return {
        id: tokenId,
        apiKey: rawKey,
        scopes
      };
    },

    async writeAuditEvent(context: AuthBoundaryContext<TEnv>) {
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<AuditBody>(context.request);
      const resourceType = readOptionalString(body.resourceType ?? body.targetType) ?? "portal";
      const resourceId = readOptionalString(body.resourceId ?? body.targetId) ?? "frontier-workspace";
      const action = readOptionalString(body.action) ?? "sdk_event";
      const payload = await authWorkerJson<{ id?: string }, TEnv>(context.env, "/v1/audit/events", {
        body: {
          action,
          actorUserId: currentUser.id,
          clientAppId: readOptionalString(body.clientAppId) ?? (resourceType === "app" ? resourceId : undefined),
          decision: body.decision === "allow" || body.decision === "deny" ? body.decision : undefined,
          metadata: {
            ...readRecord(body.metadata),
            legacyActorId: readOptionalString(body.actorId),
            legacyActorType: readOptionalString(body.actorType)
          },
          reason: readOptionalString(body.reason),
          resourceId,
          resourceType
        },
        errorCode: "auth_worker_audit_failed",
        fetchImpl,
        headers: serviceHeaders(context.env, deps),
        method: "POST"
      }, deps);

      return { id: payload.id };
    }
  };
}

export function authWorkerBaseUrl<TEnv extends AuthBoundaryEnv>(
  env: TEnv,
  deps: Pick<AuthBoundaryDeps<TEnv>, "httpError">
) {
  const base = env.AUTH_WORKER_URL?.trim();

  if (!base) {
    throw deps.httpError(503, "auth_worker_url_not_configured");
  }

  return base.replace(/\/+$/, "");
}

export function authWorkerUser(currentUser: CurrentUser) {
  return {
    id: currentUser.id,
    email: currentUser.email,
    name: currentUser.name,
    role: currentUser.role,
    team: currentUser.team,
    department: currentUser.department,
    status: "active"
  };
}

async function authWorkerJson<T, TEnv extends AuthBoundaryEnv>(
  env: TEnv,
  path: string,
  init: {
    body?: unknown;
    errorCode: string;
    fetchImpl: typeof fetch;
    headers?: Headers;
    method?: string;
  },
  deps: Pick<AuthBoundaryDeps<TEnv>, "httpError">
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await init.fetchImpl(`${authWorkerBaseUrl(env, deps)}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw deps.httpError(response.status, `${init.errorCode}:${responseText.slice(0, 160)}`);
  }

  return parseJson(responseText, deps) as T;
}

function authWorkerHeaders<TEnv extends AuthBoundaryEnv>(currentUser: CurrentUser, context: AuthBoundaryContext<TEnv>) {
  const headers = new Headers();
  headers.set("x-request-id", context.request.headers.get("x-request-id") ?? crypto.randomUUID());
  headers.set("x-workspace-user-id", currentUser.id);
  headers.set("x-workspace-provider-subject-id", currentUser.identity.objectId);
  headers.set("x-workspace-user-email", currentUser.email);
  headers.set("x-workspace-user-name", currentUser.name);
  headers.set("x-workspace-role", currentUser.role);
  headers.set("x-workspace-team-name", currentUser.team);
  if (currentUser.department) {
    headers.set("x-workspace-department", currentUser.department);
  }
  return headers;
}

function serviceHeaders<TEnv extends AuthBoundaryEnv>(
  env: TEnv,
  deps: Pick<AuthBoundaryDeps<TEnv>, "httpError">
) {
  return new Headers({ Authorization: `Bearer ${requireServiceToken(env, deps)}` });
}

function requireServiceToken<TEnv extends AuthBoundaryEnv>(
  env: TEnv,
  deps: Pick<AuthBoundaryDeps<TEnv>, "httpError">
) {
  const token = env.AUTH_SERVICE_TOKEN?.trim();

  if (!token) {
    throw deps.httpError(503, "auth_service_token_not_configured");
  }

  return token;
}

async function loadLaunchableApp<TEnv extends AuthBoundaryEnv>(
  db: D1Database,
  appId: string,
  deps: Pick<AuthBoundaryDeps<TEnv>, "httpError">
) {
  const app = await db
    .prepare(
      `
      SELECT
        id,
        name,
        status,
        sdk_status AS sdkStatus,
        launch_url AS launchUrl,
        callback_url AS callbackUrl,
        access_mode AS accessMode,
        access_targets_json AS accessTargetsJson,
        publisher_user_id AS publisherUserId,
        business_owner_user_id AS businessOwnerUserId
      FROM apps
      WHERE id = ?
      LIMIT 1
      `
    )
    .bind(appId)
    .first<LaunchableApp>();

  if (!app) {
    throw deps.httpError(404, "app_not_found");
  }

  if (app.status !== "listed") {
    throw deps.httpError(409, "app_not_listed");
  }

  if (app.sdkStatus !== "connected") {
    throw deps.httpError(409, "app_sdk_not_connected");
  }

  if (!readOptionalString(app.callbackUrl)) {
    throw deps.httpError(409, "app_callback_not_configured");
  }

  assertHttpUrl(app.callbackUrl, "invalid_app_callback_url", deps);
  assertHttpUrl(app.launchUrl, "invalid_app_launch_url", deps);

  return app;
}

function assertHttpUrl<TEnv extends AuthBoundaryEnv>(
  value: string,
  errorCode: string,
  deps: Pick<AuthBoundaryDeps<TEnv>, "httpError">
) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported_protocol");
    }
    return url;
  } catch {
    throw deps.httpError(400, errorCode);
  }
}

function normalizeApiKeySubjectType<TEnv extends AuthBoundaryEnv>(
  value: unknown,
  deps: Pick<AuthBoundaryDeps<TEnv>, "httpError">
) {
  const subjectType = readOptionalString(value) ?? "user";

  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(subjectType)) {
    throw deps.httpError(400, "invalid_subject_type");
  }

  return subjectType;
}

function sanitizeApiKeyScopes(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(
    value
      .map((scope) => readString(scope).trim())
      .filter((scope) => /^[a-z0-9:*._/-]{1,120}$/i.test(scope))
  )).slice(0, 50);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(digest);
}

function base64UrlEncode(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function parseJson<TEnv extends AuthBoundaryEnv>(
  value: string,
  deps: Pick<AuthBoundaryDeps<TEnv>, "httpError">
) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    throw deps.httpError(502, "auth_worker_invalid_json");
  }
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}
