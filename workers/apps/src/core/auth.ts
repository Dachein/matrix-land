import { HttpError, type Env, type Principal } from "./types";
import { readString, slugify } from "./utils";

export async function resolvePrincipal(request: Request, env: Env): Promise<Principal> {
  assertSafeDevAuthBypass(request, env);
  const token = bearerToken(request);

  if (token) {
    const payload = await verifyOrDecodeJwt(token, env, request);
    const scopes = Array.isArray(payload.scopes) ? payload.scopes.map(String) : [];
    const orgId = readString(payload.org_id || payload.orgId).trim();
    const sub = readString(payload.sub).trim();

    if (!sub || !orgId) {
      throw new HttpError(401, "invalid_apps_token");
    }

    return {
      appId: optionalString(payload.app_id || payload.appId),
      departmentId: optionalString(payload.department_id || payload.departmentId),
      departmentName: optionalString(payload.department || payload.departmentName),
      departmentPath: stringArray(payload.department_path || payload.departmentPath),
      email: optionalString(payload.email),
      name: optionalString(payload.name),
      skillId: optionalString(payload.skill_id || payload.skillId),
      sub,
      orgId,
      orgSlug: slugify(readString(payload.org_slug || payload.orgSlug) || orgId) || "org",
      scopes,
      tokenType: optionalString(payload.typ),
      platformRole: optionalString(payload.platform_role)
    };
  }

  if (env.DEV_AUTH_BYPASS === "1") {
    const userId = request.headers.get("x-workspace-user-id")?.trim() || "local.apps@example.invalid";
    const email = request.headers.get("x-workspace-user-email")?.trim() || (userId.includes("@") ? userId : undefined);
    const orgId = request.headers.get("x-workspace-org-id")?.trim() || "example-org";
    const orgSlug = slugify(request.headers.get("x-workspace-org-slug") || orgId) || "org";
    const scopes = (request.headers.get("x-workspace-scopes") || "apps:apps:read,apps:apps:write,apps:apps:admin,apps:skills:read,apps:skills:write,apps:skills:admin,apps:mates:read,apps:mates:write,apps:mates:admin,apps:secrets:write,apps:deploy:production")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);

    return {
      departmentId: request.headers.get("x-workspace-department-id")?.trim() || undefined,
      departmentName: request.headers.get("x-workspace-department-name")?.trim() || undefined,
      departmentPath: headerPath(request.headers.get("x-workspace-department-path")),
      email,
      name: request.headers.get("x-workspace-user-name")?.trim() || undefined,
      sub: userId,
      orgId,
      orgSlug,
      scopes
    };
  }

  throw new HttpError(401, "missing_apps_token");
}

export function assertScope(principal: Principal, acceptedScopes: string[]) {
  if (principal.scopes.includes("apps:*") || acceptedScopes.some((scope) => principal.scopes.includes(scope))) {
    return;
  }

  throw new HttpError(403, "insufficient_apps_scope");
}

export async function encryptSecretValue(env: Env, value: string) {
  const keyMaterial = readString(env.APPS_SECRET_ENCRYPTION_KEY || env.APPS_JWT_SECRET).trim();

  if (!keyMaterial) {
    throw new HttpError(503, "secret_encryption_not_configured");
  }

  return encryptWithKeyMaterial(keyMaterial, value);
}

async function encryptWithKeyMaterial(keyMaterial: string, value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial));
  const key = await crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));

  return {
    algorithm: "AES-GCM",
    cipherIv: bytesToBase64(iv),
    cipherText: bytesToBase64(new Uint8Array(cipher))
  };
}

export async function decryptSecretValue(env: Env, input: { algorithm?: string; cipherIv?: string; cipherText?: string }) {
  if (readString(input.algorithm || "AES-GCM") !== "AES-GCM") {
    throw new HttpError(500, "unsupported_secret_algorithm");
  }

  const keyMaterial = readString(env.APPS_SECRET_ENCRYPTION_KEY || env.APPS_JWT_SECRET).trim();
  if (!keyMaterial) {
    throw new HttpError(503, "secret_encryption_not_configured");
  }

  return decryptWithKeyMaterial(keyMaterial, input);
}

async function decryptWithKeyMaterial(keyMaterial: string, input: { cipherIv?: string; cipherText?: string }) {
  const cipherText = readString(input.cipherText).trim();
  const cipherIv = readString(input.cipherIv).trim();
  if (!cipherText || !cipherIv) {
    throw new HttpError(409, "secret_value_not_configured");
  }

  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial));
  const key = await crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["decrypt"]);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(cipherIv) }, key, base64ToBytes(cipherText));
    return new TextDecoder().decode(plain);
  } catch {
    throw new HttpError(500, "secret_decryption_failed");
  }
}

async function verifyOrDecodeJwt(token: string, env: Env, request: Request): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new HttpError(401, "invalid_apps_token");
  }

  const secrets = jwtSecrets(env);
  if (secrets.length === 0 && env.DEV_AUTH_BYPASS !== "1") {
    throw new HttpError(503, "apps_jwt_secret_not_configured");
  }
  if (secrets.length === 0) {
    assertSafeDevAuthBypass(request, env);
  }

  const payload = parseJwtPayload(parts[1]);

  if (secrets.length > 0) {
    const signed = `${parts[0]}.${parts[1]}`;
    const signature = base64UrlToBytes(parts[2]);
    let valid = false;
    for (const secret of secrets) {
      const expected = await hmacSha256(signed, secret);
      valid = valid || constantTimeEqual(signature, expected);
    }
    if (!valid) {
      throw new HttpError(401, "invalid_apps_token_signature");
    }
  }

  const exp = Number(payload.exp);
  if (Number.isFinite(exp) && exp > 0 && exp < Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, "apps_token_expired");
  }

  return payload;
}

function jwtSecrets(env: Env) {
  return [env.APPS_JWT_SECRET, env.WORKSPACE_MCP_JWT_SECRET]
    .map((secret) => readString(secret).trim())
    .filter(Boolean);
}

function assertSafeDevAuthBypass(request: Request, env: Env) {
  if (env.DEV_AUTH_BYPASS !== "1") {
    return;
  }

  if (isLocalDevelopmentRequest(request)) {
    return;
  }

  throw new HttpError(503, "dev_auth_bypass_forbidden");
}

function isLocalDevelopmentRequest(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function bearerToken(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function optionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function headerPath(value: string | null) {
  if (!value?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return stringArray(parsed);
    }
  } catch {
    // Fall through to the comma-delimited development header format.
  }

  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function hmacSha256(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function parseJwtPayload(value: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as Record<string, unknown>;
  } catch {
    throw new HttpError(401, "invalid_apps_token_payload");
  }
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return base64ToBytes(padded);
}

function base64ToBytes(value: string) {
  const padded = value.padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
