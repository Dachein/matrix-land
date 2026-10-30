import { missingConfiguration } from "../../../../../src/shared/requiredConfiguration.ts";
import { signJwt } from "../../auth.ts";
import { HttpError, type Env, type Principal } from "../../types.ts";

export async function callMailRuntime(env: Env, principal: Principal, name: string, args: Record<string, unknown>) {
  if (principal.runtimeService && !principal.mateId) throw new HttpError(403, "mail_mate_context_required");
  const secret = env.MATE_RUNTIME_JWT_SECRET?.trim();
  if (!secret || secret.length < 32) throw new HttpError(503, "mate_runtime_jwt_secret_not_configured");
  if (!principal.orgId) throw new HttpError(403, "mail_org_identity_missing");
  const token = await signJwt({ aud: "workspace-mate-runtime", sub: principal.sub, org_id: principal.orgId,
    caller_kind: "user", runtime_mode: "live", ...(principal.mateId ? { mail_mate_id: principal.mateId } : {}),
    scopes: [name === "mail_send" || name === "mail_reply" ? "mail:send" : name === "mail_update" ? "mail:write" : "mail:read"], exp: Math.floor(Date.now() / 1000) + 60 }, secret);
  const origin = new URL(env.MATE_RUNTIME_URL || missingConfiguration("MATE_RUNTIME_URL"));
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new HttpError(503, "mail_runtime_url_invalid");
  const request = new Request(`${origin.origin}/v1/mail/${name}`, { method: "POST", body: JSON.stringify(args),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" } });
  const response = env.MATE_RUNTIME ? await env.MATE_RUNTIME.fetch(request) : await fetch(request);
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new HttpError(response.status, typeof payload.error === "string" ? payload.error : "mail_request_failed");
  return payload;
}
