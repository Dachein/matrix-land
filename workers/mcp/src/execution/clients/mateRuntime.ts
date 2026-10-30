import { missingConfiguration } from "../../../../../src/shared/requiredConfiguration.ts";
import { signJwt } from "../../auth.ts";
import { readString } from "../../http.ts";
import { type Env, HttpError, type Principal } from "../../types.ts";
import { isRecord } from "../values.ts";

export async function callMateRuntime(
  env: Env,
  principal: Principal,
  mateId: string,
  path: string,
  options: { body?: Record<string, unknown>; method?: "GET" | "POST" } = {}
) {
  const secret = env.MATE_RUNTIME_JWT_SECRET?.trim();
  if (!secret || secret.length < 32) throw new HttpError(503, "mate_runtime_jwt_secret_not_configured");
  const orgId = principal.orgId?.trim();
  if (!orgId) throw new HttpError(403, "mate_runtime_org_identity_missing");
  const token = await signJwt({
    typ: "mate_runtime_access",
    aud: "workspace-mate-runtime",
    iss: env.AUTH_ISSUER ?? missingConfiguration("AUTH_ISSUER"),
    sub: principal.sub,
    org_id: orgId,
    email: principal.email,
    caller_kind: "user",
    scopes: ["mate:invoke", "mate:preferences"],
    exp: Math.floor(Date.now() / 1000) + 300
  }, secret);
  const configured = env.MATE_RUNTIME_URL?.trim();
  if (!env.MATE_RUNTIME && !configured) throw new HttpError(503, "mate_runtime_preview_not_configured");
  const origin = configured ? safeMateRuntimeOrigin(configured) : "https://mate-runtime.internal";
  const request = new Request(`${origin}/v1/mates/${encodeURIComponent(mateId)}${path}`, {
    body: options.body ? JSON.stringify(options.body) : undefined,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    method: options.method ?? "GET"
  });
  const response = env.MATE_RUNTIME ? await env.MATE_RUNTIME.fetch(request) : await fetch(request);
  const raw = await response.text();
  let payload: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    payload = isRecord(value) ? value : {};
  } catch {
    throw new HttpError(502, "mate_runtime_response_invalid");
  }
  if (!response.ok) throw new HttpError(response.status, readString(payload.error) || "mate_runtime_request_failed");
  return payload;
}

function safeMateRuntimeOrigin(value: string) {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error();
    return url.origin;
  } catch {
    throw new HttpError(503, "mate_runtime_url_invalid");
  }
}
