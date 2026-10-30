import { withDefaultAgent } from "../identity/defaultAgent.ts";
import {
  buildWorkspaceAccessPageUrl,
  WORKSPACE_ACCESS_RESULT_TYPE,
  type WorkspacePublicAccessCode,
  publicAccessCodeForReason
} from "../../../../sdk/auth/access.ts";
import { authCodeTtlSeconds, authPublicUrl, issuer } from "../configuration.ts";
import { json, readJson } from "../http.ts";
import { resolveAuthorizeUser, resolveRequestUser, userFromTokenPayload } from "../identity/users.ts";
import { evaluateAppAccess } from "../policy.ts";
import { consumeAppLaunchCode, createAppLaunchCode, readAppClient, recordAppUserLogin } from "../repositories/apps.ts";
import { readGrantStatus } from "../repositories/grants.ts";
import { recordAuditEvent } from "../repositories/audit.ts";
import { resolveAuthoritativeAuthUserSnapshot } from "../repositories/users/login.ts";
import { requireServiceToken } from "../serviceAuthorization.ts";
import { redirect } from "../session/cookies.ts";
import { signAuthToken, tokenTtlSeconds, verifyAuthToken } from "../token.ts";
import { type AppClient, type Env, type WorkspaceUser, HttpError } from "../types.ts";
import { readOptionalString, readString, requireText } from "../values.ts";
import { requireAppClientAuthentication, resolveAppClient, resolveRequestApp, resolveRequestGrantStatus } from "./clients.ts";
import { assertCallbackAllowed, buildDirectJumpUrl, firstCallbackUrl, sameCallbackUrl, validateRedirectUrl } from "./navigation.ts";
import type { AppLaunchExchangeBody, DirectJumpBody, VerifyBody } from "./types.ts";

// Own app access decisions, signed denial responses and one-use launch exchange as one flow.
export async function authorizeFromApp(request: Request, env: Env, url: URL, requestId: string) {
  const appId = requireText(url.searchParams.get("app_id"), "missing_app_id", 160);
  const redirectUri = requireText(url.searchParams.get("redirect_uri"), "missing_redirect_uri", 600);
  const redirectUrl = readOptionalString(url.searchParams.get("redirect_url"));
  const app = await resolveAppClient(env, appId);

  assertCallbackAllowed(app, redirectUri);

  const authUser = await resolveAuthorizeUser(request, env);
  if (!authUser) {
    return redirectToAuthorizeLogin(env, url);
  }

  let user;
  try {
    user = await resolveAuthoritativeAuthUserSnapshot(env, authUser);
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) {
      return redirectAppAccessDenied(env, app, error.code, requestId);
    }
    throw error;
  }
  const access = evaluateAppAccess({
    action: "launch",
    app,
    grantStatus: await readGrantStatus(env, app.id, user.id),
    requestId,
    user
  });
  await auditDecision(env, access, user, requestId);

  if (access.decision !== "allow") {
    return redirectAppAccessDenied(env, app, access.reason, requestId);
  }

  const code = await issueAppLaunchCode(env, app, user, requestId, redirectUri, redirectUrl);
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code.code);
  callback.searchParams.set("app_id", app.id);
  if (code.redirectUrl) {
    callback.searchParams.set("redirect_url", code.redirectUrl);
  }

  return redirect(callback.toString());
}

async function redirectAppAccessDenied(
  env: Env,
  app: AppClient,
  reason: string,
  requestId: string
) {
  const accessResult = await signAppAccessResult(env, app, reason, requestId);
  return redirect(buildWorkspaceAccessPageUrl(authPublicUrl(env), accessResult));
}

async function appAccessDeniedJson(env: Env, app: AppClient, reason: string, requestId: string) {
  return json({
    accessResult: await signAppAccessResult(env, app, reason, requestId),
    error: "access_denied",
    requestId
  }, { status: 403 });
}

async function signAppAccessResult(env: Env, app: AppClient, reason: string, requestId: string) {
  const code: WorkspacePublicAccessCode = publicAccessCodeForReason(reason);
  return signAuthToken(env, {
    appId: app.id,
    appName: app.name || "Workspace App",
    code,
    exp: Math.floor(Date.now() / 1000) + 5 * 60,
    launchUrl: app.launchUrl,
    requestId,
    typ: WORKSPACE_ACCESS_RESULT_TYPE
  });
}

export async function inspectAppAccessResult(env: Env, url: URL) {
  const result = requireText(url.searchParams.get("result"), "missing_access_result", 8_000);
  const payload = await verifyAuthToken(env, result);
  const code = readString(payload.code) as WorkspacePublicAccessCode;
  const allowedCodes = new Set<WorkspacePublicAccessCode>([
    "ACCESS_NOT_GRANTED",
    "ACCESS_PENDING",
    "USER_INACTIVE",
    "APP_UNAVAILABLE"
  ]);
  if (payload.typ !== WORKSPACE_ACCESS_RESULT_TYPE || !allowedCodes.has(code)) {
    throw new HttpError(401, "invalid_access_result");
  }

  return json({
    app: {
      id: readString(payload.appId),
      name: readString(payload.appName) || "Workspace App"
    },
    code,
    launchUrl: safePublicLaunchUrl(payload.launchUrl),
    requestId: readString(payload.requestId),
    valid: true
  });
}

function safePublicLaunchUrl(value: unknown) {
  const text = readString(value).trim();
  if (!text) {
    return undefined;
  }
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function redirectToAuthorizeLogin(env: Env, authorizeUrl: URL) {
  const publicAuthorizeUrl = new URL("/auth/v1/authorize", authPublicUrl(env));
  publicAuthorizeUrl.search = authorizeUrl.search;

  // Enter the shared Frontier Workspace sign-in experience so the user can choose either
  // Entra ID or email OTP. Both methods resume this exact authorize request.
  const loginUrl = new URL("/", authPublicUrl(env));
  loginUrl.searchParams.set("return_to", publicAuthorizeUrl.toString());
  return redirect(loginUrl.toString());
}

export async function evaluateDecision(request: Request, env: Env, requestId: string) {
  requireServiceToken(request, env);
  const body = await readJson<DirectJumpBody & { action?: "visibility" | "launch" | "token" }>(request);
  const user = await resolveRequestUser(request, env, body.user);
  const app = await resolveRequestApp(request, env, body);
  const access = evaluateAppAccess({
    action: body.action ?? "launch",
    app,
    grantStatus: await resolveRequestGrantStatus(request, env, body, app.id, user.id),
    requestId,
    user
  });

  await auditDecision(env, access, user, requestId);

  return json({ ...access, requestId });
}

export async function auditDecision(env: Env, access: ReturnType<typeof evaluateAppAccess>, user: WorkspaceUser, requestId: string) {
  await recordAuditEvent(env, {
    action: `app_${access.action}_decision`,
    actorUserId: user.id,
    clientAppId: access.appId,
    decision: access.decision,
    metadata: { policyVersion: access.policyVersion },
    reason: access.reason,
    requestId,
    resourceId: access.appId,
    resourceType: "app"
  });
}

export async function createDirectJump(request: Request, env: Env, requestId: string) {
  requireServiceToken(request, env);
  const body = await readJson<DirectJumpBody>(request);
  const user = await resolveRequestUser(request, env, body.user);
  const app = await resolveRequestApp(request, env, body);
  const access = evaluateAppAccess({
    action: "launch",
    app,
    grantStatus: await resolveRequestGrantStatus(request, env, body, app.id, user.id),
    requestId,
    user
  });

  await auditDecision(env, access, user, requestId);

  if (access.decision !== "allow") {
    throw new HttpError(403, access.reason);
  }

  const issued = await issueDirectJumpToken(env, app, user, body.redirectUrl);
  const callbackUrl = firstCallbackUrl(app);
  const directJumpUrl = callbackUrl ? buildDirectJumpUrl(callbackUrl, app.id, issued.token, issued.redirectUrl) : undefined;

  return json({
    ...issued,
    appId: app.id,
    directJumpUrl,
    requestId
  });
}

export async function verifyDirectJump(request: Request, env: Env, requestId: string) {
  const body = await readJson<VerifyBody>(request);
  const token = requireText(body.token, "missing_direct_jump_token", 4096);
  const payload = await verifyAuthToken(env, token);

  if (payload.typ !== "direct_jump") {
    throw new HttpError(401, "invalid_token_type");
  }

  if (body.appId && body.appId !== payload.app_id) {
    throw new HttpError(401, "token_app_mismatch");
  }

  const user = await resolveAuthoritativeAuthUserSnapshot(env, userFromTokenPayload(payload));
  const appId = String(payload.app_id ?? "");
  const app = await readAppClient(env, appId);
  let lastAccess: ReturnType<typeof evaluateAppAccess> | undefined;

  if (app) {
    const access = evaluateAppAccess({
      action: "token",
      app,
      grantStatus: await readGrantStatus(env, app.id, user.id),
      requestId,
      user
    });
    lastAccess = access;
    await auditDecision(env, access, user, requestId);

    if (access.decision !== "allow") {
      throw new HttpError(403, access.reason);
    }
  }

  await recordAuditEvent(env, {
    action: "verified_direct_jump",
    actorUserId: user.id,
    clientAppId: appId,
    decision: "allow",
    reason: "token_valid",
    requestId,
    resourceId: appId,
    resourceType: "app"
  });

  if (app && lastAccess) {
    await recordAppUserLogin(env, {
      access: lastAccess,
      app,
      requestId,
      user
    });
  }

  return json({
    valid: true,
    appId,
    expiresAt: payload.exp,
    redirectUrl: payload.redirect_url,
    requestId,
    user: await withDefaultAgent(env, user)
  });
}

export async function exchangeAppLaunchCode(request: Request, env: Env, requestId: string) {
  const body = await readJson<AppLaunchExchangeBody>(request);
  const appId = requireText(body.clientId ?? body.appId, "missing_app_id", 160);
  const redirectUri = requireText(body.redirectUri, "missing_redirect_uri", 600);
  const app = await resolveAppClient(env, appId);

  await requireAppClientAuthentication(request, env, app.id);
  assertCallbackAllowed(app, redirectUri);

  const code = requireText(body.code, "missing_launch_code", 4096);
  const consumed = await consumeAppLaunchCode(env, code, app.id);
  if (!sameCallbackUrl(consumed.callbackUrl, redirectUri)) {
    throw new HttpError(401, "launch_code_redirect_uri_mismatch");
  }

  let user;
  try {
    user = await resolveAuthoritativeAuthUserSnapshot(env, consumed.user);
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) {
      return appAccessDeniedJson(env, app, error.code, requestId);
    }
    throw error;
  }
  const access = evaluateAppAccess({
    action: "token",
    app,
    grantStatus: await readGrantStatus(env, app.id, user.id),
    requestId,
    user
  });

  await auditDecision(env, access, user, requestId);

  if (access.decision !== "allow") {
    return appAccessDeniedJson(env, app, access.reason, requestId);
  }

  await recordAppUserLogin(env, {
    access,
    app,
    requestId,
    user
  });

  await recordAuditEvent(env, {
    action: "exchanged_app_launch_code",
    actorUserId: user.id,
    clientAppId: app.id,
    decision: "allow",
    reason: "launch_code_valid",
    requestId,
    resourceId: app.id,
    resourceType: "app"
  });

  return json({
    valid: true,
    appId: app.id,
    expiresAt: consumed.expiresAt,
    redirectUrl: consumed.redirectUrl,
    requestId,
    user: await withDefaultAgent(env, user)
  });
}

async function issueDirectJumpToken(env: Env, app: AppClient, user: WorkspaceUser, redirectUrl?: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + tokenTtlSeconds(env);
  const normalizedRedirectUrl = validateRedirectUrl(app, redirectUrl);
  const token = await signAuthToken(env, {
    typ: "direct_jump",
    iss: issuer(env),
    aud: app.id,
    sub: user.id,
    email: user.email,
    jobTitle: "",
    name: user.name,
    role: user.role,
    team: user.team,
    team_id: user.teamId,
    team_path: user.teamPath ?? [],
    department: user.department,
    department_id: user.departmentId,
    department_path: user.departmentPath ?? [],
    app_id: app.id,
    redirect_url: normalizedRedirectUrl,
    exp: expiresAt
  });

  return {
    token,
    tokenType: "Bearer",
    expiresAt,
    redirectUrl: normalizedRedirectUrl
  };
}

async function issueAppLaunchCode(env: Env, app: AppClient, user: WorkspaceUser, requestId: string, callbackUrl: string, redirectUrl?: string) {
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + authCodeTtlSeconds(env);
  const normalizedRedirectUrl = validateRedirectUrl(app, redirectUrl);
  return createAppLaunchCode(env, {
    app,
    callbackUrl,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    redirectUrl: normalizedRedirectUrl,
    requestId,
    user
  });
}
