import { readAuthUserById } from "../repositories/users/reads.ts";
import { enrollVerifiedOtpRecipient } from "../emailOtpEnrollment.ts";
import {
  consumeEmailOtpChallenge,
  createEmailOtpChallenge,
  emailOtpSessionTtlSeconds,
  emailOtpStateCookie,
  requireOtpRecipientUnchanged,
  requireLoginEmailAllowed
} from "../emailOtp.ts";
import { json, readJson } from "../http.ts";
import { normalizeCanonicalIdentityProvider } from "../identity/users.ts";
import { resolveEmailOtpAuthUserById } from "../repositories/users/login.ts";
import { normalizeLoginReturnTo, normalizeRedirectPath } from "../session/navigation.ts";
import type { Env } from "../types.ts";
import { finishConfirmedLogin } from "./session.ts";
import type { EmailOtpRequestBody, EmailOtpVerifyBody } from "./types.ts";

// Email OTP request and verification; session issuance stays with the session owner.
export async function requestEmailOtpLogin(
  request: Request,
  env: Env,
  requestId: string
) {
  const body = await readJson<EmailOtpRequestBody>(request);
  const redirectPath = normalizeRedirectPath(body.redirect ?? env.POST_LOGIN_REDIRECT_PATH ?? "/home");
  const returnTo = normalizeLoginReturnTo(request, env, body.returnTo);
  const challenge = await createEmailOtpChallenge({
    email: body.email,
    env,
    redirectPath,
    returnTo,
    request,
    requestId
  });
  return json({
    accepted: true,
    challengeId: challenge.challengeId,
    expiresIn: challenge.expiresIn,
    retryAfter: challenge.retryAfter,
    message: "如果该邮箱已获授权，验证码将发送至邮箱。"
  }, {
    status: 202,
    headers: {
      "Cache-Control": "no-store",
      "Set-Cookie": emailOtpStateCookie(challenge.state, request, challenge.expiresIn)
    }
  });
}

export async function completeEmailOtpLogin(request: Request, env: Env, requestId: string) {
  const body = await readJson<EmailOtpVerifyBody>(request);
  const consumed = await consumeEmailOtpChallenge({
    challengeId: body.challengeId,
    code: body.code,
    env,
    request
  });
  const userId = consumed.userId ?? await enrollVerifiedOtpRecipient(env, consumed.id, consumed.recipientCiphertext!);
  const account = await readAuthUserById(env, userId);
  await requireOtpRecipientUnchanged(env, account?.email, consumed.emailHash);
  await requireLoginEmailAllowed(env, account?.email);
  const sessionUser = await resolveEmailOtpAuthUserById(env, userId);
  const canonicalProvider = normalizeCanonicalIdentityProvider(sessionUser.identityProvider);
  const runtimeUser = sessionUser;
  const resolvedSessionUser = sessionUser;

  return finishConfirmedLogin(request, env, {
    authenticationMethod: "email_otp",
    authenticationSubject: `email-otp:${consumed.id}`,
    identity: {
      avatarUrl: "",
      objectId: sessionUser.providerSubject ?? sessionUser.id,
      principalName: sessionUser.email ?? "",
      provider: canonicalProvider,
      tenantId: canonicalProvider === "microsoft_entra_id"
        ? env.ENTRA_TENANT_ID ?? ""
        : env.WORKSPACE_ORG_ID ?? "workspace"
    },
    redirectPath: consumed.redirectPath,
    requestId,
    responseMode: "json",
    returnTo: consumed.returnTo,
    runtimeUser,
    sessionTtlSeconds: emailOtpSessionTtlSeconds(env),
    sessionUser: resolvedSessionUser
  });
}
