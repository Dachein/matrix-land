import { requireEntraAuthConfig } from "../configuration.ts";
import { base64UrlDecode, base64UrlDecodeBytes, claimValue, randomBase64Url, sha256 } from "../crypto.ts";
import { requireLoginEmailAllowed } from "../emailOtp.ts";
import { readAuthUserByProvider } from "../repositories/users/reads.ts";
import { requireAuthoritativeSessionUser } from "../identity/users.ts";
import { cookieHeader, cookieValue, redirect } from "../session/cookies.ts";
import { normalizeLoginReturnTo, normalizeRedirectPath } from "../session/navigation.ts";
import { signAuthToken, verifyAuthToken } from "../token.ts";
import { type Env, type WorkspaceUser, HttpError } from "../types.ts";
import { normalizeRole, readOptionalString, readString } from "../values.ts";
import { finishConfirmedLogin, redirectToLoginError } from "./session.ts";
import type { EntraGraphProfile, EntraJsonWebKey, EntraTokenResponse, OAuthStatePayload } from "./types.ts";

// Own the Entra authorization callback, token validation and profile adapter.
export async function startEntraLogin(request: Request, env: Env) {
  const config = requireEntraAuthConfig(env, request);
  const requestUrl = new URL(request.url);
  const redirectPath = normalizeRedirectPath(requestUrl.searchParams.get("redirect") ?? env.POST_LOGIN_REDIRECT_PATH ?? "/home");
  const returnTo = normalizeLoginReturnTo(request, env, requestUrl.searchParams.get("return_to"));
  const state = randomBase64Url(32);
  const nonce = randomBase64Url(32);
  const verifier = randomBase64Url(64);
  const challenge = await sha256(verifier);
  const linkingUser = requestUrl.searchParams.get("link") === "1" ? await requireAuthoritativeSessionUser(request, env) : undefined;
  const stateToken = await signAuthToken(env, {
    linkUserId: linkingUser?.id,
    typ: "oauth_state",
    state,
    nonce,
    verifier,
    redirectPath,
    returnTo,
    exp: Math.floor(Date.now() / 1000) + 600
  });
  await env.AUTH_DB.prepare("INSERT INTO auth_oauth_states (state_hash, expires_at) VALUES (?, ?)")
    .bind(await sha256(state), Math.floor(Date.now() / 1000) + 600).run();
  const authorizeUrl = new URL(`${config.authority}/oauth2/v2.0/authorize`);

  if (linkingUser) authorizeUrl.searchParams.set("prompt", "select_account");
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizeUrl.searchParams.set("response_mode", "query");
  authorizeUrl.searchParams.set("scope", config.scopes);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("nonce", nonce);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  return redirect(authorizeUrl.toString(), {
    headers: {
      "Set-Cookie": cookieHeader("workspace_oauth_state", stateToken, request, {
        maxAge: 600,
        sameSite: "Lax"
      })
    }
  });
}

export async function completeEntraLogin(request: Request, env: Env, requestId: string) {
  const config = requireEntraAuthConfig(env, request);
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return redirectToLoginError(request, errorDescription ?? error);
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const stateCookie = cookieValue(request, "workspace_oauth_state");

  if (!code || !returnedState || !stateCookie) {
    return redirectToLoginError(request, "missing_oauth_state");
  }

  let statePayload: OAuthStatePayload;

  try {
    statePayload = await verifyAuthToken(env, stateCookie) as OAuthStatePayload;
  } catch {
    return redirectToLoginError(request, "invalid_oauth_state");
  }

  if (statePayload.typ !== "oauth_state" || statePayload.state !== returnedState || !statePayload.verifier || !statePayload.nonce) {
    return redirectToLoginError(request, "invalid_oauth_state");
  }

  const consumedState = await env.AUTH_DB.prepare("DELETE FROM auth_oauth_states WHERE state_hash = ? AND expires_at >= ? RETURNING state_hash")
    .bind(await sha256(statePayload.state), Math.floor(Date.now() / 1000)).first();
  if (!consumedState) return redirectToLoginError(request, "oauth_state_expired_or_consumed");

  try {
    const tokenResponse = await exchangeEntraCode(config, code, statePayload.verifier);
    if (!tokenResponse.id_token) throw new HttpError(401, "missing_id_token");
    const claims = await verifyEntraIdToken(config, tokenResponse.id_token, statePayload.nonce);
    const tenantId = readString(claims.tid);
    const objectId = readString(claims.oid);
    if (!objectId || !tenantId) throw new HttpError(401, "missing_entra_identity");
    const provider = "microsoft_entra_id";
    const subject = `${tenantId}:${objectId}`;
    let sessionUser = await readAuthUserByProvider(env, provider, subject);
    if (statePayload.linkUserId) {
      const verifiedUser = await requireAuthoritativeSessionUser(request, env);
      if (verifiedUser.id !== statePayload.linkUserId) throw new HttpError(403, "identity_link_session_changed");
      await requireLoginEmailAllowed(env, verifiedUser.email);
      if (sessionUser && sessionUser.id !== verifiedUser.id) throw new HttpError(409, "identity_already_linked");
      // Do not overwrite a different established provider identity.
      const result = await env.AUTH_DB.prepare(`UPDATE auth_users SET provider = ?, provider_subject = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'active' AND (provider_subject IS NULL OR provider_subject = '' OR (provider = ? AND provider_subject = ?))`)
        .bind(provider, subject, verifiedUser.id, provider, subject).run();
      if (!result.meta.changes) throw new HttpError(409, "identity_link_conflict");
      sessionUser = await readAuthUserByProvider(env, provider, subject);
    }
    if (!sessionUser) throw new HttpError(428, "identity_link_required");
    if (sessionUser.status !== "active") throw new HttpError(403, "auth_user_inactive");
    await requireLoginEmailAllowed(env, sessionUser.email);
    return await finishConfirmedLogin(request, env, {
      identity: { provider, tenantId, objectId, principalName: sessionUser.email ?? "", avatarUrl: "" },
      redirectPath: statePayload.redirectPath, returnTo: statePayload.returnTo,
      requestId, runtimeUser: sessionUser, sessionUser
    });
  } catch (error) {
    return redirectToLoginError(request, error instanceof HttpError ? error.message : "entra_login_failed");
  }
}

async function exchangeEntraCode(config: ReturnType<typeof requireEntraAuthConfig>, code: string, verifier: string): Promise<EntraTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri
  });

  if (config.clientSecret) {
    body.set("client_secret", config.clientSecret);
  }

  const response = await fetch(`${config.authority}/oauth2/v2.0/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json() as EntraTokenResponse;

  if (!response.ok) {
    throw new HttpError(401, payload.error_description ?? payload.error ?? "entra_token_exchange_failed");
  }

  return payload;
}

export async function verifyEntraIdToken(config: ReturnType<typeof requireEntraAuthConfig>, idToken: string, nonce: string) {
  const [encodedHeader, encodedPayload, encodedSignature] = idToken.split(".");

  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new HttpError(401, "malformed_id_token");
  }

  const header = JSON.parse(base64UrlDecode(encodedHeader)) as Record<string, unknown>;
  const claims = JSON.parse(base64UrlDecode(encodedPayload)) as Record<string, unknown>;
  const kid = readOptionalString(header.kid);

  if (!kid) {
    throw new HttpError(401, "missing_id_token_key_id");
  }

  const discoveryResponse = await fetch(`${config.authority}/v2.0/.well-known/openid-configuration`);

  if (!discoveryResponse.ok) {
    throw new HttpError(502, "entra_discovery_unavailable");
  }

  const discovery = await discoveryResponse.json() as { issuer?: string; jwks_uri?: string };
  const jwksUri = readOptionalString(discovery.jwks_uri);

  if (!jwksUri) {
    throw new HttpError(502, "entra_jwks_unavailable");
  }

  const jwksResponse = await fetch(jwksUri);

  if (!jwksResponse.ok) {
    throw new HttpError(502, "entra_jwks_unavailable");
  }

  const jwks = await jwksResponse.json() as { keys?: EntraJsonWebKey[] };
  const jwk = jwks.keys?.find((key) => key.kid === kid);

  if (!jwk) {
    throw new HttpError(401, "id_token_key_not_found");
  }

  const cryptoKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const isValidSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    base64UrlDecodeBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  );

  if (!isValidSignature) {
    throw new HttpError(401, "invalid_id_token_signature");
  }

  validateEntraClaims(config, claims, nonce, discovery.issuer);
  return claims;
}

function validateEntraClaims(config: ReturnType<typeof requireEntraAuthConfig>, claims: Record<string, unknown>, nonce: string, issuer?: string) {
  const audience = claims.aud;
  const audiences = Array.isArray(audience) ? audience.map(String) : [String(audience ?? "")];

  if (!audiences.includes(config.clientId)) {
    throw new HttpError(401, "invalid_id_token_audience");
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = Number(claims.exp);
  const nbf = claims.nbf == null ? undefined : Number(claims.nbf);

  if (!Number.isFinite(exp) || exp <= now) {
    throw new HttpError(401, "id_token_expired");
  }

  if (typeof nbf === "number" && Number.isFinite(nbf) && nbf > now + 60) {
    throw new HttpError(401, "id_token_not_active");
  }

  if (readString(claims.nonce) !== nonce) {
    throw new HttpError(401, "invalid_id_token_nonce");
  }

  const tenantId = readString(claims.tid);
  const expectedIssuer = readOptionalString(issuer) ?? `${config.authority}/v2.0`;

  if (readString(claims.iss) !== expectedIssuer) {
    throw new HttpError(401, "invalid_id_token_issuer");
  }

  if (tenantId !== config.tenantId) {
    throw new HttpError(401, "invalid_id_token_tenant");
  }
}
