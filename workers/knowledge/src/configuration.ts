import type { Env } from "./types.ts";
import { HttpError } from "./http.ts";



export function assertLocalDevRequest(request: Request) {
  const urlHostname = new URL(request.url).hostname.toLowerCase();
  const hostHeader = (request.headers.get("host") ?? "").split(":")[0]?.toLowerCase() ?? "";
  if (isLocalHostname(urlHostname) || isLocalHostname(hostHeader)) {
    return;
  }
  if (!request.headers.has("cf-ray")) {
    return;
  }
  throw new HttpError(503, "dev_auth_bypass_forbidden");
}

export function authWorkerUrl(env: Env) {
  const base = env.AUTH_WORKER_URL?.trim();
  if (!base) {
    throw new HttpError(503, "auth_worker_url_not_configured");
  }
  return base.replace(/\/+$/, "");
}

export function knowledgeAudience(env: Env) {
  const audience=env.KNOWLEDGE_PUBLIC_URL?.trim();
  if(!audience) throw new HttpError(503,"knowledge_public_url_not_configured");
  return audience;
}

export function configuredKnowledgeOrgId(env: Env) {
  const orgId = env.KNOWLEDGE_ORG_ID?.trim();
  if (!orgId) {
    throw new HttpError(503, "knowledge_org_id_not_configured");
  }
  return orgId;
}

function isLocalHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}
