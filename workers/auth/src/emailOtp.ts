import { platformBrandFromEnv, type PlatformBrand } from "../../../src/shared/platformBrand.ts";
import { renderLoginCodeEmail } from "../../../src/shared/systemEmailTemplates.ts";
import { readAuthUserByEmail, isLoginEligibleAuthUser } from "./repositories/users/reads.ts";
import { sealOtpRecipient } from "./emailOtpEnrollment.ts";
import { HttpError, type Env } from "./types.ts";
import { isEmailAllowedByInstallation, isEmailAllowedByPolicy, readAuthEmailPolicy } from "../../../src/shared/authEmailPolicy.ts";

const DEFAULT_TTL_SECONDS = 600;
const DEFAULT_COOLDOWN_SECONDS = 60;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_EMAIL_HOURLY_LIMIT = 5;
const DEFAULT_IP_HOURLY_LIMIT = 20;
const DEFAULT_VERIFY_HOURLY_LIMIT = 10;
const DEFAULT_GLOBAL_HOURLY_LIMIT = 200;

type EmailOtpConfig = {
  cooldownSeconds: number;
  emailHourlyLimit: number;
  from: string;
  globalHourlyLimit: number;
  ipHourlyLimit: number;
  maxAttempts: number;
  secret: string;
  ttlSeconds: number;
  verifyHourlyLimit: number;
};

export type EmailOtpChallenge = {
  challengeId: string;
  expiresIn: number;
  retryAfter: number;
  state: string;
};

export function isEmailOtpConfigured(env: Env) {
  if (env.EMAIL_OTP_ENABLED !== "1") {
    return false;
  }

  return Boolean(
    env.AUTH_DB &&
    env.AUTH_EMAIL?.send &&
    validEmailOtpSecret(env.AUTH_EMAIL_OTP_SECRET) &&
    normalizeEmail(env.EMAIL_OTP_FROM ?? "") &&
    emailOtpProxyTokens(env).length > 0
  );
}

export function emailOtpSessionTtlSeconds(env: Env) {
  return boundedInteger(env.EMAIL_OTP_SESSION_TTL_SECONDS, 604800, 300, 604800);
}

export async function createEmailOtpChallenge(input: {
  email: unknown;
  env: Env;
  redirectPath: string;
  returnTo?: string;
  request: Request;
  requestId: string;
}): Promise<EmailOtpChallenge> {
  const config = requireEmailOtpConfig(input.env);
  const trustedRequest = requireTrustedEmailOtpRequest(input.request, input.env);
  const normalizedEmail = normalizeEmail(input.email);
  if (!isEmailAllowedByInstallation(input.env.AUTH_LOGIN_ALLOWED_EMAILS_JSON, normalizedEmail)
    || !isEmailAllowedByPolicy(await readAuthEmailPolicy(input.env.AUTH_DB), normalizedEmail)) {
    throw new HttpError(403, "email_otp_not_eligible");
  }

  const eligibleUser = await readAuthUserByEmail(input.env, normalizedEmail);
  const recipient = normalizeEmail(eligibleUser?.email ?? normalizedEmail);
  if (!recipient || (eligibleUser ? !isLoginEligibleAuthUser(eligibleUser) : input.env.EMAIL_OTP_ALLOW_SIGNUP !== "1")) {
    throw new HttpError(403, "email_otp_not_eligible");
  }

  const state = randomBase64Url(32);
  const code = randomSixDigitCode();
  const reviewMode = trustedRequest.channel === "miniapp"
    && Boolean(input.env.MINIAPP_REVIEW_EMAIL)
    && normalizedEmail === normalizeEmail(input.env.MINIAPP_REVIEW_EMAIL)
    && miniappReviewOtpCodes(input.env).length > 0;
  const challengeId = crypto.randomUUID();
  const recipientCiphertext = eligibleUser ? null : await sealOtpRecipient(input.env, challengeId, recipient);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + config.ttlSeconds;
  const [emailHash, ipHash, stateHash, codeHash] = await Promise.all([
    hmac(config.secret, `email:v1:${normalizedEmail || "invalid"}`),
    hmac(config.secret, `ip:v1:${trustedRequest.clientIp}`),
    hmac(config.secret, `state:v1:${state}`),
    hmac(config.secret, reviewMode ? `review-code:v1:${state}` : `code:v1:${state}:${code}`)
  ]);
  const status = "pending";
  const inserted = await input.env.AUTH_DB
    .prepare(
      `
      INSERT INTO auth_email_otp_challenges (
        id,
        user_id,
        recipient_ciphertext,
        email_hash,
        ip_hash,
        state_hash,
        code_hash,
        status,
        attempt_count,
        max_attempts,
        expires_at,
        consumed_at,
        consume_nonce,
        provider_message_id,
        request_id,
        redirect_path,
        return_to,
        created_at,
        updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1
        FROM auth_email_otp_challenges
        WHERE email_hash = ? AND created_at > ?
      )
        AND (
          SELECT COUNT(*)
          FROM auth_email_otp_challenges
          WHERE email_hash = ? AND created_at > ?
        ) < ?
        AND (
          SELECT COUNT(*)
          FROM auth_email_otp_challenges
          WHERE ip_hash = ? AND created_at > ?
        ) < ?
        AND (
          SELECT COUNT(*)
          FROM auth_email_otp_challenges
          WHERE created_at > ?
        ) < ?
      RETURNING id
      `
    )
    .bind(
      challengeId,
      eligibleUser?.id ?? null,
      recipientCiphertext,
      emailHash,
      ipHash,
      stateHash,
      codeHash,
      status,
      config.maxAttempts,
      expiresAt,
      input.requestId,
      input.redirectPath,
      input.returnTo ?? null,
      now,
      now,
      emailHash,
      now - config.cooldownSeconds,
      emailHash,
      now - 3600,
      config.emailHourlyLimit,
      ipHash,
      now - 3600,
      config.ipHourlyLimit,
      now - 3600,
      config.globalHourlyLimit
    )
    .first<{ id: string }>();

  if (!inserted?.id) {
    throw new HttpError(429, "email_otp_rate_limited");
  }

  if (!reviewMode) {
    const delivered = await deliverEmailOtp(input.env, config, {
      challengeId,
      code,
      recipient
    });
    if (!delivered) {
      throw new HttpError(503, "email_otp_delivery_failed");
    }
  }

  return {
    challengeId,
    expiresIn: config.ttlSeconds,
    retryAfter: config.cooldownSeconds,
    state
  };
}

export async function consumeEmailOtpChallenge(input: {
  challengeId: unknown;
  code: unknown;
  env: Env;
  request: Request;
}) {
  const config = requireEmailOtpConfig(input.env);
  const trustedRequest = requireTrustedEmailOtpRequest(input.request, input.env);
  const challengeId = readText(input.challengeId);
  const code = readText(input.code);
  const state = cookieValue(input.request, "workspace_email_otp_state");

  if (!isUuid(challengeId) || !/^\d{6}$/.test(code) || !/^[A-Za-z0-9_-]{40,50}$/.test(state)) {
    throw invalidEmailOtp();
  }

  const reviewCode = trustedRequest.channel === "miniapp" && miniappReviewOtpCodes(input.env).includes(code) ? 1 : 0;
  const [stateHash, codeHash, reviewCodeHash, reviewEmailHash] = await Promise.all([
    hmac(config.secret, `state:v1:${state}`),
    hmac(config.secret, `code:v1:${state}:${code}`),
    hmac(config.secret, `review-code:v1:${state}`),
    hmac(config.secret, `email:v1:${normalizeEmail(input.env.MINIAPP_REVIEW_EMAIL) || "review-disabled"}`)
  ]);
  const now = Math.floor(Date.now() / 1000);
  const consumeNonce = crypto.randomUUID();
  const consumed = await input.env.AUTH_DB
    .prepare(
      `
      UPDATE auth_email_otp_challenges
      SET status = 'consumed',
          consumed_at = ?,
          consume_nonce = ?,
          updated_at = ?
      WHERE id = ?
        AND state_hash = ?
        AND (
          code_hash = ?
          OR (code_hash = ? AND email_hash = ? AND ? = 1)
        )
        AND status = 'pending'
        AND expires_at > ?
        AND attempt_count < max_attempts
        AND (user_id IS NOT NULL OR (? = 1 AND recipient_ciphertext IS NOT NULL))
        AND (
          SELECT COALESCE(SUM(attempt_count), 0)
          FROM auth_email_otp_challenges AS recent
          WHERE recent.email_hash = auth_email_otp_challenges.email_hash
            AND recent.created_at > ?
        ) < ?
      RETURNING id, user_id AS userId, recipient_ciphertext AS recipientCiphertext, email_hash AS emailHash, redirect_path AS redirectPath, return_to AS returnTo
      `
    )
    .bind(
      now,
      consumeNonce,
      now,
      challengeId,
      stateHash,
      codeHash,
      reviewCodeHash,
      reviewEmailHash,
      reviewCode,
      now,
      input.env.EMAIL_OTP_ALLOW_SIGNUP === "1" ? 1 : 0,
      now - 3600,
      config.verifyHourlyLimit
    )
    .first<{ id: string; redirectPath: string; returnTo?: string; userId: string | null; recipientCiphertext: string | null; emailHash: string }>();

  if (consumed?.id && (consumed.userId || consumed.recipientCiphertext)) {
    return { ...consumed, reviewCode: Boolean(reviewCode) };
  }

  await input.env.AUTH_DB
    .prepare(
      `
      UPDATE auth_email_otp_challenges
      SET attempt_count = attempt_count + 1,
          status = CASE
            WHEN attempt_count + 1 >= max_attempts THEN 'locked'
            ELSE status
          END,
          updated_at = ?
      WHERE id = ?
        AND state_hash = ?
        AND status = 'pending'
        AND expires_at > ?
        AND attempt_count < max_attempts
        AND (
          SELECT COALESCE(SUM(attempt_count), 0)
          FROM auth_email_otp_challenges AS recent
          WHERE recent.email_hash = auth_email_otp_challenges.email_hash
            AND recent.created_at > ?
        ) < ?
      `
    )
    .bind(now, challengeId, stateHash, now, now - 3600, config.verifyHourlyLimit)
    .run();

  throw invalidEmailOtp();
}

export function emailOtpStateCookie(
  state: string,
  request: Request,
  maxAge = DEFAULT_TTL_SECONDS
) {
  const attributes = [
    `workspace_email_otp_state=${encodeURIComponent(state)}`,
    "Path=/auth/email",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`
  ];
  if (new URL(request.url).protocol === "https:") {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

export function clearEmailOtpStateCookie(request: Request) {
  const attributes = [
    "workspace_email_otp_state=",
    "Path=/auth/email",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0"
  ];
  if (new URL(request.url).protocol === "https:") {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

async function deliverEmailOtp(
  env: Env,
  config: EmailOtpConfig,
  input: { challengeId: string; code: string; recipient: string }
) {
  try {
    const result = await env.AUTH_EMAIL!.send({
      from: config.from,
      ...renderLoginCodeEmail(input.code, config.ttlSeconds, config.maxAttempts, platformBrandFromEnv(env)),
      to: input.recipient
    });
    const resultStatus = readText(result.status).toLowerCase();
    if (resultStatus === "failed") {
      throw new Error("email_provider_reported_failure");
    }

    await env.AUTH_DB
      .prepare(
        `
        UPDATE auth_email_otp_challenges
        SET provider_message_id = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
        `
      )
      .bind(readText(result.messageId).slice(0, 240) || null, Math.floor(Date.now() / 1000), input.challengeId)
      .run();
    return true;
  } catch {
    await env.AUTH_DB
      .prepare(
        `
        UPDATE auth_email_otp_challenges
        SET status = 'delivery_failed', updated_at = ?
        WHERE id = ? AND status = 'pending'
        `
      )
      .bind(Math.floor(Date.now() / 1000), input.challengeId)
      .run();
    return false;
  }
}

function requireEmailOtpConfig(env: Env): EmailOtpConfig {
  if (!isEmailOtpConfigured(env)) {
    throw new HttpError(503, env.EMAIL_OTP_ENABLED === "1" ? "email_otp_not_configured" : "email_otp_disabled");
  }

  return {
    cooldownSeconds: boundedInteger(env.EMAIL_OTP_COOLDOWN_SECONDS, DEFAULT_COOLDOWN_SECONDS, 30, 600),
    emailHourlyLimit: boundedInteger(env.EMAIL_OTP_EMAIL_HOURLY_LIMIT, DEFAULT_EMAIL_HOURLY_LIMIT, 1, 100),
    from: normalizeEmail(env.EMAIL_OTP_FROM ?? ""),
    globalHourlyLimit: boundedInteger(env.EMAIL_OTP_GLOBAL_HOURLY_LIMIT, DEFAULT_GLOBAL_HOURLY_LIMIT, 10, 10000),
    ipHourlyLimit: boundedInteger(env.EMAIL_OTP_IP_HOURLY_LIMIT, DEFAULT_IP_HOURLY_LIMIT, 1, 500),
    maxAttempts: boundedInteger(env.EMAIL_OTP_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1, 10),
    secret: env.AUTH_EMAIL_OTP_SECRET!.trim(),
    ttlSeconds: boundedInteger(env.EMAIL_OTP_TTL_SECONDS, DEFAULT_TTL_SECONDS, 300, 900),
    verifyHourlyLimit: boundedInteger(env.EMAIL_OTP_VERIFY_HOURLY_LIMIT, DEFAULT_VERIFY_HOURLY_LIMIT, 1, 100)
  };
}

function requireTrustedEmailOtpRequest(request: Request, env: Env) {
  const receivedToken = readText(request.headers.get("x-workspace-auth-proxy-token"));
  if (!receivedToken || !emailOtpProxyTokens(env).some((expectedToken) => safeEqual(expectedToken, receivedToken))) {
    throw new HttpError(403, "email_otp_proxy_auth_required");
  }

  const clientIp = readText(request.headers.get("x-workspace-client-ip"));
  if (!clientIp || clientIp.length > 96 || !/^[0-9a-fA-F:.]+$/.test(clientIp)) {
    throw new HttpError(403, "email_otp_client_ip_required");
  }

  const publicOrigin = normalizeOrigin(request.headers.get("x-workspace-public-origin"));
  const origin = normalizeOrigin(request.headers.get("origin"));
  if (origin && publicOrigin && origin === publicOrigin && allowedPortalOrigins(env, request).has(origin)) {
    return { clientIp: clientIp.toLowerCase(), channel: "portal" as const };
  }

  const channel = readText(request.headers.get("x-workspace-auth-channel"));
  if (channel === "miniapp" && publicOrigin && allowedPortalOrigins(env, request).has(publicOrigin)) {
    return { clientIp: clientIp.toLowerCase(), channel: "miniapp" as const };
  }

  throw new HttpError(403, "email_otp_origin_invalid");
}

function miniappReviewOtpCodes(env: Env) {
  const code = readText(env.MINIAPP_REVIEW_OTP_CODE);
  return /^\d{6}$/.test(code) ? [code] : [];
}

function emailOtpProxyTokens(env: Env) {
  return [
    env.PORTAL_AUTH_SERVICE_TOKEN,
    env.AUTH_SERVICE_TOKEN,
    env.AUTH_SERVICE_TOKEN_SECONDARY
  ]
    .map(readText)
    .filter(Boolean);
}

function allowedPortalOrigins(env: Env, request: Request) {
  const origins = new Set<string>();
  [env.AUTH_PUBLIC_URL, env.PORTAL_URL].map(normalizeOrigin).filter(Boolean).forEach((origin) => origins.add(origin));
  const requestOrigin = normalizeOrigin(request.headers.get("x-workspace-public-origin"));
  if (requestOrigin && isLocalOrigin(requestOrigin)) {
    origins.add(requestOrigin);
  }
  return origins;
}

export async function requireLoginEmailAllowed(env: Env, email: unknown) {
  const policy = await readAuthEmailPolicy(env.AUTH_DB);
  if (!isEmailAllowedByInstallation(env.AUTH_LOGIN_ALLOWED_EMAILS_JSON, email)
    || !isEmailAllowedByPolicy(policy, email)) throw new HttpError(403, "company_email_required");
}

function normalizeEmail(value: unknown) {
  const email = readText(value).toLowerCase();
  if (email.length > 240 || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    return "";
  }
  return email;
}

function validEmailOtpSecret(value: unknown) {
  return new TextEncoder().encode(readText(value)).byteLength >= 32;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(readText(value), 10);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.min(parsed, maximum) : fallback;
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOrigin(value: unknown) {
  const text = readText(value);
  if (!text) {
    return "";
  }
  try {
    return new URL(text).origin;
  } catch {
    return "";
  }
}

function isLocalOrigin(origin: string) {
  const hostname = new URL(origin).hostname.toLowerCase();
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function invalidEmailOtp() {
  return new HttpError(400, "email_otp_invalid_or_expired");
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function randomSixDigitCode() {
  const rejectionLimit = 16_000_000;
  const bytes = new Uint8Array(3);
  while (true) {
    crypto.getRandomValues(bytes);
    const value = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
    if (value < rejectionLimit) {
      return String(value % 1_000_000).padStart(6, "0");
    }
  }
}

function randomBase64Url(length: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return base64Url(bytes);
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  return base64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function base64Url(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** Compatibility export for existing preview tooling. */
export function renderEmailOtpHtml(code: string, ttlSeconds: number, maxAttempts: number, brand?: PlatformBrand) {
  return renderLoginCodeEmail(code, ttlSeconds, maxAttempts, brand).html;
}

export async function requireOtpRecipientUnchanged(env: Env, email: string | undefined, expectedHash: string) {
  const config = requireEmailOtpConfig(env);
  if (await hmac(config.secret, `email:v1:${normalizeEmail(email)}`) !== expectedHash) {
    throw new HttpError(403, "email_otp_recipient_changed");
  }
}
