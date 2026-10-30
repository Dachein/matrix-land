import { HttpError, type Env } from "./types.ts";

export async function signAuthToken(env: Env, payload: Record<string, unknown>) {
  return signToken(payload, authSecret(env));
}

export async function signMcpAccessToken(env: Env, payload: Record<string, unknown>) {
  return signToken(payload, mcpAccessSecret(env));
}

async function signToken(payload: Record<string, unknown>, secret: string) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256(`${encodedHeader}.${encodedPayload}`, secret);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export async function verifyAuthToken(env: Env, token: string) {
  return verifyToken(token, authSecret(env));
}

export async function verifyMcpAccessToken(env: Env, token: string) {
  return verifyToken(token, mcpAccessSecret(env));
}

async function verifyToken(token: string, secret: string) {
  const [encodedHeader, encodedPayload, signature] = token.split(".");

  if (!encodedHeader || !encodedPayload || !signature || token.split(".").length !== 3) {
    throw new HttpError(401, "malformed_token");
  }

  const expected = await hmacSha256(`${encodedHeader}.${encodedPayload}`, secret);

  if (!safeEqual(signature, expected)) {
    throw new HttpError(401, "invalid_token_signature");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as Record<string, unknown>;
  } catch {
    throw new HttpError(401, "invalid_token_payload");
  }
  const exp = Number(payload.exp);

  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, "token_expired");
  }

  return payload;
}

export function tokenTtlSeconds(env: Env) {
  const parsed = Number.parseInt(env.TOKEN_TTL_SECONDS ?? "900", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 900;
}

function authSecret(env: Env) {
  if (!env.AUTH_JWT_SECRET) {
    throw new HttpError(503, "auth_jwt_secret_not_configured");
  }

  return env.AUTH_JWT_SECRET;
}

function mcpAccessSecret(env: Env) {
  const secret = env.MCP_ACCESS_JWT_SECRET?.trim();
  if (!secret) {
    throw new HttpError(503, "mcp_access_jwt_secret_not_configured");
  }

  return secret;
}

async function hmacSha256(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncode(signature);
}

function base64UrlEncode(value: string | ArrayBuffer | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return diff === 0;
}
