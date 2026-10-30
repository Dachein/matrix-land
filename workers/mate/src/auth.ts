import { RuntimeHttpError, type RuntimeEnv, type RuntimeMode, type RuntimePrincipal } from "./types.ts";

export async function resolveRuntimePrincipal(request: Request, env: RuntimeEnv): Promise<RuntimePrincipal> {
  const url = new URL(request.url);
  if (env.DEV_AUTH_BYPASS === "1" && isLocal(url.hostname)) {
    const ownerTest = url.pathname.startsWith("/owner/mates/") || url.pathname.startsWith("/v1/owner-test/mates/");
    const mateId = ownerTest ? mateIdFromOwnerTestPath(url.pathname) : "";
    const releaseId = ownerTest ? text(url.searchParams.get("release")) : "";
    return {
      callerKind: normalizeCallerKind(request.headers.get("x-workspace-caller-kind")),
      departmentId: request.headers.get("x-workspace-department-id")?.trim() || undefined,
      departmentPath: splitPath(request.headers.get("x-workspace-department-path")),
      email: request.headers.get("x-workspace-user-email")?.trim() || undefined,
      name: request.headers.get("x-workspace-user-name")?.trim() || undefined,
      orgId: request.headers.get("x-workspace-org-id")?.trim() || "local-org",
      orgSlug: request.headers.get("x-workspace-org-slug")?.trim() || undefined,
      scopes: splitScopes(request.headers.get("x-workspace-scopes") || "mate:invoke,mate:preferences,mate:owner_test"),
      testGrant: mateId && releaseId ? { releaseId, mateId } : undefined,
      userId: request.headers.get("x-workspace-user-id")?.trim() || "local-user"
    };
  }

  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new RuntimeHttpError(401, "runtime_token_required");
  const [header, body, signature, extra] = token.split(".");
  if (!header || !body || !signature || extra) throw new RuntimeHttpError(401, "runtime_token_invalid");
  let claims: Record<string, unknown>;
  try { claims = JSON.parse(new TextDecoder().decode(base64UrlBytes(body))) as Record<string, unknown>; }
  catch { throw new RuntimeHttpError(401, "runtime_token_invalid"); }
  const claimedMode = claims.runtime_mode === "preview"
    ? "preview"
    : claims.runtime_mode === "live" ? "live" : "";
  const secret = runtimeJwtVerificationSecret(env, claimedMode, claims);
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["verify"]);
    valid = await crypto.subtle.verify("HMAC", key, base64UrlBytes(signature), new TextEncoder().encode(`${header}.${body}`));
  } catch { /* The stable invalid-token response below is intentionally opaque. */ }
  if (!valid) throw new RuntimeHttpError(401, "runtime_token_invalid");
  if (claims.runtime_mode !== undefined && !claimedMode) {
    throw new RuntimeHttpError(401, "runtime_token_invalid");
  }
  const userId = text(claims.sub);
  const orgId = text(claims.org_id || claims.orgId);
  const exp = Number(claims.exp);
  if (!userId || !orgId || claims.aud !== "workspace-mate-runtime" || !Number.isFinite(exp) || exp <= Date.now() / 1000) {
    throw new RuntimeHttpError(401, "runtime_token_invalid");
  }
  const testGrant = testGrantFromClaims(claims);
  if (claimedMode === "preview" && !testGrant) throw new RuntimeHttpError(401, "runtime_token_invalid");
  return {
    callerKind: normalizeCallerKind(text(claims.caller_kind || claims.callerKind)),
    mailMateId: text(claims.mail_mate_id) || undefined,
    departmentId: text(claims.department_id || claims.departmentId) || undefined,
    departmentPath: stringArray(claims.department_path || claims.departmentPath),
    email: text(claims.email) || undefined,
    name: text(claims.name) || undefined,
    orgId,
    orgSlug: text(claims.org_slug || claims.orgSlug) || undefined,
    scopes: Array.isArray(claims.scopes) ? claims.scopes.map(text).filter(Boolean) : [],
    testGrant,
    userId
  };
}

function runtimeJwtVerificationSecret(env: RuntimeEnv, claimedMode: string, claims: Record<string, unknown>) {
  const liveSecret = env.MATE_RUNTIME_JWT_SECRET?.trim() || "";
  const previewSecret = env.MATE_PREVIEW_JWT_SECRET?.trim() || "";
  if (claimedMode === "preview") {
    if (!previewSecret) {
      throw new RuntimeHttpError(503, "runtime_preview_jwt_secret_not_configured");
    }
    if (previewSecret.length < 32 || (liveSecret && previewSecret === liveSecret)) {
      throw new RuntimeHttpError(503, "runtime_preview_jwt_secret_invalid");
    }
    return previewSecret;
  }
  // Portal-issued browser sessions use the existing Web Host signing domain,
  // never the Agent/MCP Runtime issuer secret. The explicit token_use prevents
  // a Preview grant from being interpreted as Live authority.
  if (claimedMode === "live" && claims.token_use === "mate_web_session") {
    if (!previewSecret || previewSecret.length < 32 || (liveSecret && previewSecret === liveSecret)) {
      throw new RuntimeHttpError(503, "runtime_web_session_jwt_secret_invalid");
    }
    return previewSecret;
  }
  if (liveSecret.length < 32) throw new RuntimeHttpError(503, "runtime_jwt_secret_not_configured");
  return liveSecret;
}

export function requireRuntimeScope(principal: RuntimePrincipal, scope: string) {
  if (!principal.scopes.includes("mate:*") && !principal.scopes.includes(scope)) {
    throw new RuntimeHttpError(403, "runtime_scope_insufficient");
  }
}

/** A Preview-bound browser token must never be downgraded into Live access. */
export function requireRuntimeMode(principal: RuntimePrincipal, mode: RuntimeMode) {
  if (mode === "live" && principal.testGrant) {
    throw new RuntimeHttpError(403, "runtime_mode_mismatch");
  }
}

function normalizeCallerKind(value: unknown): RuntimePrincipal["callerKind"] {
  const kind = text(value);
  return kind === "app" || kind === "mate" || kind === "email_binding" ? kind : "user";
}

function splitScopes(value: string) { return value.split(",").map((scope) => scope.trim()).filter(Boolean); }
function splitPath(value: string | null) { return value?.split(",").map((item) => item.trim()).filter(Boolean) || undefined; }
function stringArray(value: unknown) { return Array.isArray(value) ? value.map(text).filter(Boolean) : undefined; }
function testGrantFromClaims(claims: Record<string, unknown>) {
  if (claims.runtime_mode !== "preview") return undefined;
  const mateId = text(claims.mate_id);
  const releaseId = text(claims.release_id);
  return mateId && releaseId ? { mateId, releaseId } : undefined;
}
function mateIdFromOwnerTestPath(pathname: string) {
  const match = pathname.match(/^\/(?:owner|v1\/owner-test)\/mates\/([^/]+)/);
  try { return match?.[1] ? decodeURIComponent(match[1]) : ""; }
  catch { return ""; }
}
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function isLocal(hostname: string) { return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost"); }
function base64UrlBytes(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}
