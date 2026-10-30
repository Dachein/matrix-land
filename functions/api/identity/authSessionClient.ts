import { defaultAgentInfo } from "../../../sdk/auth/types.ts";
import { HttpError } from "../http.ts";
import { normalizeAuthenticationMethod, normalizeIdentityProvider, normalizeRole, readOptionalString, readString } from "../values.ts";
import type { AuthPrincipal, IdentityEnv } from "./types.ts";

export type AuthWorkerSession = {
  emailLoginConfigured: boolean;
  emailLoginUrl: string;
  principal?: AuthPrincipal;
};

export async function readAuthWorkerSession<TEnv extends IdentityEnv>(
  request: Request,
  env: TEnv
): Promise<AuthWorkerSession> {
  let response: Response;

  try {
    response = await fetch(`${authWorkerBaseUrl(env)}/auth/session`, {
      headers: authSessionHeaders(request)
    });
  } catch {
    throw new HttpError(502, "auth_worker_session_unavailable");
  }

  if (response.status === 401 || response.status === 403) {
    return anonymousAuthWorkerSession();
  }

  if (!response.ok) {
    throw new HttpError(502, "auth_worker_session_failed");
  }

  const payload = await response.json() as Record<string, unknown>;
  const session: AuthWorkerSession = {
    emailLoginConfigured: payload.emailLoginConfigured === true,
    emailLoginUrl: "/auth/email/login"
  };

  if (payload.authenticated !== true) {
    return session;
  }

  if (!payload.user || typeof payload.user !== "object" || Array.isArray(payload.user)) {
    throw new HttpError(502, "auth_worker_invalid_session");
  }

  const principal = authPrincipalFromSessionUser(payload.user as Record<string, unknown>);

  if (!principal) {
    throw new HttpError(502, "auth_worker_invalid_user");
  }

  return { ...session, principal };
}

export async function readAuthWorkerSessionPrincipal<TEnv extends IdentityEnv>(
  request: Request,
  env: TEnv
): Promise<AuthPrincipal | undefined> {
  if (!hasAuthCredentials(request)) {
    return undefined;
  }

  return (await readAuthWorkerSession(request, env)).principal;
}

export function requireAuthWorkerConfigured(env: IdentityEnv) {
  authWorkerBaseUrl(env);
}

export function isPortalAuthConfigured(env: IdentityEnv) {
  return Boolean(env.AUTH_WORKER_URL?.trim());
}

function authSessionHeaders(request: Request) {
  const headers = new Headers({ accept: "application/json" });
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");

  if (cookie) {
    headers.set("cookie", cookie);
  } else if (authorization) {
    headers.set("authorization", authorization);
  }

  return headers;
}

function hasAuthCredentials(request: Request) {
  return Boolean(request.headers.get("cookie") || request.headers.get("authorization"));
}

function anonymousAuthWorkerSession(): AuthWorkerSession {
  return {
    emailLoginConfigured: false,
    emailLoginUrl: "/auth/email/login"
  };
}

function authPrincipalFromSessionUser(user: Record<string, unknown>): AuthPrincipal | undefined {
  const userId = readString(user.id) || readString(user.userId);
  const email = readString(user.email);

  if (!userId || !email) {
    return undefined;
  }

  const identity = user.identity && typeof user.identity === "object" && !Array.isArray(user.identity)
    ? user.identity as Record<string, unknown>
    : {};
  const principalName = readString(identity.principalName) || readString(user.principalName) || email;
  const objectId =
    readString(identity.objectId) ||
    readString(identity.providerSubjectId) ||
    readString(user.providerSubjectId) ||
    userId;

  return {
    defaultAgent: defaultAgentInfo(user.defaultAgent),
    userId,
    email,
    name: readString(user.name) || email.split("@")[0],
    avatarUrl: readOptionalString(user.avatarUrl),
    team: readOptionalString(user.team),
    department: readOptionalString(user.department),
    ...(readOptionalString(user.departmentDisplayPath)
      ? { departmentDisplayPath: readOptionalString(user.departmentDisplayPath) }
      : {}),
    departmentId: readOptionalString(user.departmentId),
    departmentPath: readStringList(user.departmentPath),
    jobTitle: "",
    role: normalizeRole(user.role),
    identity: {
      authenticationMethod: normalizeAuthenticationMethod(
        readString(identity.authenticationMethod) || readString(user.authenticationMethod)
      ),
      provider: normalizeIdentityProvider(readString(identity.provider) || readString(user.identityProvider)),
      tenantId:
        readString(identity.tenantId) ||
        readString(identity.providerTenantId) ||
        readString(user.providerTenantId),
      objectId,
      principalName
    }
  };
}

function readStringList(value: unknown) {
  const source = Array.isArray(value) ? value : [];
  return source.map((item) => readString(item).trim()).filter(Boolean);
}

function authWorkerBaseUrl(env: IdentityEnv) {
  const base = env.AUTH_WORKER_URL?.trim();

  if (!base) {
    throw new HttpError(503, "auth_worker_url_not_configured");
  }

  return base.replace(/\/+$/, "");
}
