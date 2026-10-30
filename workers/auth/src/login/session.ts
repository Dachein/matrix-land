import { withDefaultAgent } from "../identity/defaultAgent.ts";
import { authPublicUrl, authPublicUrlFromRequest, getSessionTtlSeconds, isEntraAuthConfigured, issuer } from "../configuration.ts";
import { clearEmailOtpStateCookie, isEmailOtpConfigured, requireLoginEmailAllowed } from "../emailOtp.ts";
import { json } from "../http.ts";
import { userFromSessionPayload } from "../identity/users.ts";
import { readAuthDepartmentDisplayPath } from "../repositories/departments.ts";
import { recordAuditEvent } from "../repositories/audit.ts";
import { resolveAuthoritativeAuthUserSnapshot } from "../repositories/users/login.ts";
import { clearCookieHeader, cookieHeader, cookieValue, redirect } from "../session/cookies.ts";
import { normalizeLoginReturnTo, normalizeRedirectPath } from "../session/navigation.ts";
import { signAuthToken, verifyAuthToken } from "../token.ts";
import type { Env, WorkspaceUser } from "../types.ts";
import type { LoginConfirmationPayload } from "./types.ts";

// Own session issuance and termination after identity confirmation.
export async function readAuthSession(request: Request, env: Env, requestId: string) {
  const entraLoginConfigured = isEntraAuthConfigured(env);
  const configured = entraLoginConfigured || isEmailOtpConfigured(env);
  const sessionToken = cookieValue(request, "workspace_session");

  if (sessionToken) {
    try {
      const payload = await verifyAuthToken(env, sessionToken);
      const sessionUser = userFromSessionPayload(payload, env);
      const user = sessionUser
        ? await resolveAuthoritativeAuthUserSnapshot(env, sessionUser)
        : undefined;
      if (user && (!user.status || user.status === "active")) {
        await requireLoginEmailAllowed(env, user.email);
        const departmentDisplayPath = await readAuthDepartmentDisplayPath(env, user).catch(() => undefined);
        return {
          configured,
          entraLoginConfigured,
          authenticated: true,
          emailLoginConfigured: isEmailOtpConfigured(env),
          emailLoginUrl: "/auth/email/login",
          loginUrl: "/auth/entra/start",
          logoutUrl: "/auth/logout",
          requestId,
          user: await withDefaultAgent(env, { ...user, ...(departmentDisplayPath ? {departmentDisplayPath} : {}), identity: sessionUser!.identity })
        };
      }
    } catch {
      // Treat invalid or expired cookies as anonymous sessions.
    }
  }

  return {
    configured,
    entraLoginConfigured,
    authenticated: false,
    emailLoginConfigured: isEmailOtpConfigured(env),
    emailLoginUrl: "/auth/email/login",
    loginUrl: "/auth/entra/start",
    logoutUrl: "/auth/logout",
    requestId
  };
}

export async function finishConfirmedLogin(request: Request, env: Env, input: {
  authenticationMethod?: "email_otp" | "microsoft_entra_id" | "miniapp_scan" | "wechat_miniapp";
  authenticationSubject?: string;
  identity: NonNullable<LoginConfirmationPayload["identity"]>;
  redirectPath?: string;
  requestId: string;
  responseMode?: "json" | "redirect";
  returnTo?: string;
  runtimeUser: WorkspaceUser;
  sessionTtlSeconds?: number;
  sessionUser: WorkspaceUser;
}) {
  const authenticationMethod = input.authenticationMethod ?? "microsoft_entra_id";
  const sessionTtlSeconds = input.sessionTtlSeconds ?? getSessionTtlSeconds(env);
  const sessionRole = input.sessionUser.role ?? input.runtimeUser.role ?? "member";
  const sessionToken = await signAuthToken(env, {
    typ: "workspace_session",
    iss: issuer(env),
    aud: "workspace-portal",
    sub: input.sessionUser.id,
    provider: input.identity.provider,
    tid: input.identity.tenantId,
    oid: input.identity.objectId,
    principalName: input.identity.principalName,
    authenticationMethod,
    authenticationSubject: input.authenticationSubject ?? input.identity.objectId,
    amr: [authenticationMethod],
    email: input.sessionUser.email ?? input.runtimeUser.email ?? "",
    name: input.sessionUser.name ?? input.runtimeUser.name ?? "",
    avatarUrl: input.identity.avatarUrl ?? "",
    team: input.sessionUser.team ?? input.runtimeUser.team ?? "",
    department: input.sessionUser.department ?? input.runtimeUser.department ?? "",
    department_id: input.sessionUser.departmentId ?? input.runtimeUser.departmentId ?? "",
    department_path: input.sessionUser.departmentPath ?? input.runtimeUser.departmentPath ?? [],
    jobTitle: input.sessionUser.jobTitle ?? input.runtimeUser.jobTitle ?? "",
    role: sessionRole,
    exp: Math.floor(Date.now() / 1000) + sessionTtlSeconds
  });
  const returnTo = normalizeLoginReturnTo(request, env, input.returnTo);
  const target = returnTo ? new URL(returnTo) : new URL("/", authPublicUrl(env));
  if (!returnTo) {
    const redirectPath = normalizeRedirectPath(input.redirectPath ?? env.POST_LOGIN_REDIRECT_PATH ?? "/home");
    const destination = new URL(redirectPath, target.origin);
    target.pathname = destination.pathname;
    target.search = destination.search;
  }

  await recordAuditEvent(env, {
    action: "portal_user_logged_in",
    actorUserId: input.sessionUser.id,
    metadata: {
      provider: input.identity.provider,
      authenticationMethod,
      authenticationSubject: input.authenticationSubject ?? input.identity.objectId,
      tenantId: input.identity.tenantId,
      principalName: input.identity.principalName,
      providerSubject: input.identity.objectId
    },
    requestId: input.requestId,
    resourceId: input.sessionUser.id,
    resourceType: "user"
  }).catch(() => undefined);

  const headers = new Headers();
  headers.append("Set-Cookie", cookieHeader("workspace_session", sessionToken, request, {
    maxAge: sessionTtlSeconds,
    sameSite: "Lax"
  }));
  headers.append("Set-Cookie", clearCookieHeader("workspace_oauth_state", request));

  if (input.responseMode === "json") {
    headers.append("Set-Cookie", clearEmailOtpStateCookie(request));
    headers.set("Cache-Control", "no-store");
    return json({
      authenticated: true,
      redirectUrl: target.toString(),
      user: await withDefaultAgent(env, input.sessionUser)
    }, { headers });
  }

  return redirect(target.toString(), { headers });
}

export function finishLogout(request: Request) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Set-Cookie": clearCookieHeader("workspace_session", request)
  });
  if (request.headers.get("accept")?.includes("application/json")) {
    return json({ authenticated: false }, { headers });
  }
  const target = new URL("/", authPublicUrlFromRequest(request));
  target.pathname = "/home";

  return redirect(target.toString(), { headers });
}

export function redirectToLoginError(request: Request, message: string) {
  const target = new URL("/", authPublicUrlFromRequest(request));
  target.searchParams.set("auth_error", message.slice(0, 180));

  return redirect(target.toString(), {
    headers: {
      "Set-Cookie": clearCookieHeader("workspace_oauth_state", request)
    }
  });
}
