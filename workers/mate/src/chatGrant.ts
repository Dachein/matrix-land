import {
  normalizeMateChatAddress,
  normalizeMateChatRouteAddress,
  mateChatInstanceName,
  type MateChatAddress,
  type MateChatRouteAddress
} from "./chatAddress.ts";
import { RuntimeHttpError } from "./types.ts";

export const MATE_CHAT_GRANT_AUDIENCE = "workspace-mate-chat";
export const MATE_CHAT_GRANT_VERSION = 1 as const;
export const MATE_CHAT_GRANT_MAX_TTL_SECONDS = 5 * 60;
export const MATE_CHAT_GRANT_CLOCK_SKEW_SECONDS = 30;

export type MateChatGrantScope = "mate:*" | "mate:invoke";

export type MateChatGrantBinding = MateChatAddress & {
  callerKind: "user";
  departmentId?: string;
  departmentPath?: string[];
  orgId: string;
  releaseId: string;
  scopes: string[];
};

export type MateChatGrantClaims = Omit<MateChatGrantBinding, "scopes"> & {
  aud: typeof MATE_CHAT_GRANT_AUDIENCE;
  exp: number;
  iat: number;
  instanceName: string;
  jti: string;
  scopes: MateChatGrantScope[];
  version: typeof MATE_CHAT_GRANT_VERSION;
};

type NormalizedMateChatGrantBinding = Omit<MateChatGrantBinding, "scopes"> & {
  scopes: MateChatGrantScope[];
};

export type MateChatGrantDependencies = {
  crypto?: Crypto;
  now?: () => number;
  randomUUID?: () => string;
};

const GRANT_HEADER = { alg: "HS256", typ: "WORKSPACE_MATE_CHAT_GRANT" } as const;
const GRANT_REQUIRED_CLAIM_KEYS = new Set([
  "aud",
  "callerKind",
  "conversationId",
  "exp",
  "iat",
  "instanceName",
  "jti",
  "mode",
  "orgId",
  "releaseId",
  "scopes",
  "mateId",
  "userId",
  "version"
]);
const GRANT_OPTIONAL_CLAIM_KEYS = new Set(["departmentId", "departmentPath"]);
const MAX_DEPARTMENT_PATH_ITEMS = 16;
const MAX_INPUT_SCOPE_ITEMS = 64;
const MAX_TOKEN_CHARACTERS = 8_192;

export async function createMateChatGrant(
  input: MateChatGrantBinding,
  secret: string,
  options: MateChatGrantDependencies & { ttlSeconds?: number } = {}
) {
  const binding = normalizeGrantBinding(input);
  const ttlSeconds = options.ttlSeconds ?? MATE_CHAT_GRANT_MAX_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MATE_CHAT_GRANT_MAX_TTL_SECONDS) {
    throw new RuntimeHttpError(422, "mate_chat_grant_ttl_invalid");
  }
  const cryptoImpl = options.crypto ?? crypto;
  const iat = epochSeconds(options.now);
  const jti = boundedClaimText((options.randomUUID ?? (() => cryptoImpl.randomUUID()))(), "jti", 180);
  const claims: MateChatGrantClaims = {
    aud: MATE_CHAT_GRANT_AUDIENCE,
    callerKind: "user",
    conversationId: binding.conversationId,
    ...(binding.departmentId ? { departmentId: binding.departmentId } : {}),
    ...(binding.departmentPath ? { departmentPath: binding.departmentPath } : {}),
    exp: iat + ttlSeconds,
    iat,
    instanceName: await mateChatInstanceName(binding),
    jti,
    mode: binding.mode,
    orgId: binding.orgId,
    releaseId: binding.releaseId,
    scopes: binding.scopes,
    mateId: binding.mateId,
    userId: binding.userId,
    version: MATE_CHAT_GRANT_VERSION
  };
  const header = encodeJson(GRANT_HEADER);
  const payload = encodeJson(claims);
  const signed = `${header}.${payload}`;
  const signature = await hmacSha256(signed, requireSecret(secret), cryptoImpl);
  return `${signed}.${base64Url(signature)}`;
}

export async function verifyMateChatGrant(
  token: unknown,
  secret: string,
  expectedAddress?: MateChatRouteAddress,
  options: Pick<MateChatGrantDependencies, "crypto" | "now"> = {}
): Promise<MateChatGrantClaims> {
  const secretValue = requireSecret(secret);
  const cryptoImpl = options.crypto ?? crypto;
  try {
    if (typeof token !== "string" || !token || token.length > MAX_TOKEN_CHARACTERS) throw new Error("token_shape");
    const [headerPart, payloadPart, signaturePart, extra] = token.split(".");
    if (!headerPart || !payloadPart || !signaturePart || extra) throw new Error("token_shape");
    const signed = `${headerPart}.${payloadPart}`;
    const providedSignature = decodeBase64Url(signaturePart);
    const expectedSignature = await hmacSha256(signed, secretValue, cryptoImpl);
    if (!constantTimeSignatureEqual(providedSignature, expectedSignature)) throw new Error("signature_invalid");

    const header = decodeJson(headerPart);
    if (
      header.alg !== GRANT_HEADER.alg
      || header.typ !== GRANT_HEADER.typ
      || Object.keys(header).length !== Object.keys(GRANT_HEADER).length
    ) throw new Error("header_invalid");

    const payload = decodeJson(payloadPart);
    if (
      [...GRANT_REQUIRED_CLAIM_KEYS].some((key) => !Object.hasOwn(payload, key))
      || Object.keys(payload).some((key) => !GRANT_REQUIRED_CLAIM_KEYS.has(key) && !GRANT_OPTIONAL_CLAIM_KEYS.has(key))
      || payload.version !== MATE_CHAT_GRANT_VERSION
      || payload.aud !== MATE_CHAT_GRANT_AUDIENCE
      || payload.callerKind !== "user"
    ) throw new Error("claims_invalid");

    const signedAddress = normalizeMateChatAddress(payload);
    const departmentId = optionalClaimText(payload.departmentId, "departmentId", 180);
    const departmentPath = parseSignedDepartmentPath(payload.departmentPath);
    const claims = {
      aud: MATE_CHAT_GRANT_AUDIENCE,
      callerKind: "user" as const,
      conversationId: signedAddress.conversationId,
      ...(departmentId ? { departmentId } : {}),
      ...(departmentPath ? { departmentPath } : {}),
      exp: safeEpoch(payload.exp),
      iat: safeEpoch(payload.iat),
      instanceName: boundedClaimText(payload.instanceName, "instanceName", 128),
      jti: boundedClaimText(payload.jti, "jti", 180),
      mode: signedAddress.mode,
      orgId: boundedClaimText(payload.orgId, "orgId", 180),
      releaseId: boundedClaimText(payload.releaseId, "releaseId", 180),
      scopes: parseSignedScopes(payload.scopes),
      mateId: signedAddress.mateId,
      userId: signedAddress.userId,
      version: MATE_CHAT_GRANT_VERSION
    } satisfies MateChatGrantClaims;

    const derivedInstanceName = await mateChatInstanceName({
      ...signedAddress,
      releaseId: claims.releaseId
    });
    if (!constantTimeTextEqual(claims.instanceName, derivedInstanceName)) throw new Error("instance_mismatch");

    const now = epochSeconds(options.now);
    if (
      claims.exp <= claims.iat
      || claims.exp - claims.iat > MATE_CHAT_GRANT_MAX_TTL_SECONDS
      || claims.iat > now + MATE_CHAT_GRANT_CLOCK_SKEW_SECONDS
      || claims.exp <= now - MATE_CHAT_GRANT_CLOCK_SKEW_SECONDS
    ) throw new Error("time_invalid");
    if (expectedAddress) {
      const route = normalizeMateChatRouteAddress(expectedAddress);
      if (
        claims.mateId !== route.mateId
        || claims.conversationId !== route.conversationId
        || claims.mode !== route.mode
      ) throw new Error("route_binding_mismatch");
    }
    return claims;
  } catch {
    throw new RuntimeHttpError(401, "mate_chat_grant_invalid");
  }
}

export async function verifyMateChatGrantForBinding(
  token: unknown,
  secret: string,
  expected: MateChatGrantBinding,
  options: Pick<MateChatGrantDependencies, "crypto" | "now"> = {}
) {
  const expectedBinding = normalizeGrantBinding(expected);
  const claims = await verifyMateChatGrant(token, secret, expectedBinding, options);
  if (
    claims.orgId !== expectedBinding.orgId
    || claims.callerKind !== expectedBinding.callerKind
    || claims.departmentId !== expectedBinding.departmentId
    || !stringArraysEqual(claims.departmentPath, expectedBinding.departmentPath)
    || !stringArraysEqual(claims.scopes, expectedBinding.scopes)
    || claims.userId !== expectedBinding.userId
    || claims.releaseId !== expectedBinding.releaseId
  ) throw new RuntimeHttpError(401, "mate_chat_grant_invalid");
  return claims;
}

function normalizeGrantBinding(value: unknown): NormalizedMateChatGrantBinding {
  const source = record(value);
  const address = normalizeMateChatAddress(source);
  if (source.callerKind !== "user") throw new RuntimeHttpError(403, "mate_chat_user_caller_required");
  const departmentId = optionalClaimText(source.departmentId, "departmentId", 180);
  const departmentPath = normalizeBindingDepartmentPath(source.departmentPath);
  return {
    ...address,
    callerKind: "user",
    ...(departmentId ? { departmentId } : {}),
    ...(departmentPath ? { departmentPath } : {}),
    orgId: boundedClaimText(source.orgId, "orgId", 180),
    releaseId: boundedClaimText(source.releaseId, "releaseId", 180),
    scopes: normalizeBindingScopes(source.scopes)
  };
}

function requireSecret(value: unknown) {
  const secret = typeof value === "string" ? value.trim() : "";
  if (secret.length < 32) throw new RuntimeHttpError(503, "mate_chat_grant_secret_not_configured");
  return secret;
}

function epochSeconds(now: (() => number) | undefined) {
  const value = now?.() ?? Date.now();
  if (!Number.isFinite(value) || value < 0) throw new RuntimeHttpError(500, "mate_chat_clock_invalid");
  return Math.floor(value / 1_000);
}

function safeEpoch(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("epoch_invalid");
  return value;
}

function boundedClaimText(value: unknown, field: string, maximum: number) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new RuntimeHttpError(422, "mate_chat_grant_claim_invalid", { field });
  return value;
}

function optionalClaimText(value: unknown, field: string, maximum: number) {
  return value === undefined ? undefined : boundedClaimText(value, field, maximum);
}

function normalizeBindingDepartmentPath(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DEPARTMENT_PATH_ITEMS) {
    throw new RuntimeHttpError(422, "mate_chat_grant_claim_invalid", { field: "departmentPath" });
  }
  const path = value.map((item) => boundedClaimText(item, "departmentPath", 180));
  if (new Set(path).size !== path.length) {
    throw new RuntimeHttpError(422, "mate_chat_grant_claim_invalid", { field: "departmentPath" });
  }
  return path;
}

function parseSignedDepartmentPath(value: unknown) {
  if (value === undefined) return undefined;
  const path = normalizeBindingDepartmentPath(value);
  if (!path || path.length !== (value as unknown[]).length) throw new Error("department_path_invalid");
  return path;
}

function normalizeBindingScopes(value: unknown): MateChatGrantScope[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_INPUT_SCOPE_ITEMS) {
    throw new RuntimeHttpError(403, "mate_chat_scope_insufficient");
  }
  const scopes = value.map((item) => boundedClaimText(item, "scopes", 180));
  if (scopes.includes("mate:*")) return ["mate:*"];
  if (scopes.includes("mate:invoke")) return ["mate:invoke"];
  throw new RuntimeHttpError(403, "mate_chat_scope_insufficient");
}

function parseSignedScopes(value: unknown): MateChatGrantScope[] {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("scopes_invalid");
  const scope = value[0];
  if (scope !== "mate:*" && scope !== "mate:invoke") throw new Error("scopes_invalid");
  return [scope];
}

async function hmacSha256(value: string, secret: string, cryptoImpl: Crypto) {
  const key = await cryptoImpl.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  return new Uint8Array(await cryptoImpl.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function encodeJson(value: unknown) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value: string): Record<string, unknown> {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value));
  const parsed = JSON.parse(decoded) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("json_object_required");
  return parsed as Record<string, unknown>;
}

function decodeBase64Url(value: string) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error("base64url_invalid");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64Url(bytes) !== value) throw new Error("base64url_non_canonical");
  return bytes;
}

function base64Url(value: Uint8Array) {
  let binary = "";
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function constantTimeSignatureEqual(left: Uint8Array, right: Uint8Array) {
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < 64; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

function constantTimeTextEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return mismatch === 0;
}

function stringArraysEqual(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  if (!left || !right) return left === right;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
