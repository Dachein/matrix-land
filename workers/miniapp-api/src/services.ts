import { HttpError, readBody, requireConfiguredSecret } from "../../../functions/api/http.ts";
import { readAuthSession, resolveCurrentUser } from "../../../functions/api/identity/index.ts";
import { hmacSha256, signJwt } from "../../../functions/api/jwt.ts";
import { createAppsProxyApi } from "../../../functions/api/appsProxy/proxy.ts";
import { getTtlSeconds } from "../../../functions/api/values.ts";
import { createMatePreviewSessionApi } from "../../../functions/api/mateRuntime/service.ts";
import { createMiniappFacadeApi } from "./facade.ts";
import { createMiniappKnowledgeApi } from "./knowledge.ts";
import { createMiniappFileUploadApi } from "./fileUploads.ts";

export interface MiniappEnv {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  DB?: D1Database;
  DEFAULT_TEAM_ID?: string;
  DEFAULT_TEAM_NAME?: string;
  APPS_JWT_SECRET?: string;
  APPS_ORG_ID?: string;
  APPS_ORG_SLUG?: string;
  APPS_PROXY_TIMEOUT_MS?: string;
  APPS_WORKER_URL?: string;
  PORTAL_AUTH_SERVICE_TOKEN?: string;
  PORTAL_ISSUER?: string;
  PORTAL_URL?: string;
  MATE_PREVIEW_HOST_ENABLED?: string;
  MATE_PREVIEW_JWT_SECRET?: string;
  MATE_RUNTIME_URL?: string;
  TOKEN_TTL_SECONDS?: string;
  KNOWLEDGE_ORG_ID?: string;
  KNOWLEDGE_PUBLIC_URL?: string;
  KNOWLEDGE_RESOURCE_ID?: string;
  KNOWLEDGE_WORKER_URL?: string;
  UPLOAD_STAGING?: R2Bucket;
}

export type MiniappContext = EventContext<MiniappEnv, string, unknown>;

export function createMiniappServices() {
  const miniappFacadeApi = createMiniappFacadeApi<MiniappEnv>({
    httpError: (status, code) => new HttpError(status, code)
  });
  const appsProxyApi = createAppsProxyApi<MiniappEnv>({
    currentUserTeamId: async (_db, _currentUser, env) => env.DEFAULT_TEAM_ID?.trim() || "team-ai-adoption",
    getTtlSeconds,
    resolveCurrentUser,
    signAppsToken: (env, payload) => signJwt(
      payload,
      requireConfiguredSecret(env.APPS_JWT_SECRET, "apps_jwt_secret")
    )
  });
  const matePreviewSessionApi = createMatePreviewSessionApi<MiniappEnv>({
    httpError: (status, code) => new HttpError(status, code),
    opaquePrincipalKey: (value, env) => hmacSha256(value, previewJwtSecret(env)),
    readBody,
    resolveCurrentUser,
    signAppsToken: (env, payload) => signJwt(
      payload,
      requireConfiguredSecret(env.APPS_JWT_SECRET, "apps_jwt_secret")
    ),
    signRuntimeToken: (env, payload) => signJwt(payload, previewJwtSecret(env))
  });
  const knowledgeApi = createMiniappKnowledgeApi();
  const fileUploadApi = createMiniappFileUploadApi();

  return {
    fileUploadApi,
    knowledgeApi,
    appsProxyApi,
    miniappFacadeApi,
    readAuthSession,
    matePreviewSessionApi
  };
}

export type MiniappServices = ReturnType<typeof createMiniappServices>;

function previewJwtSecret(env: MiniappEnv) {
  const secret = requireConfiguredSecret(env.MATE_PREVIEW_JWT_SECRET, "mate_preview_jwt_secret");
  if (secret.length < 32) throw new HttpError(503, "mate_preview_jwt_secret_invalid");
  return secret;
}
