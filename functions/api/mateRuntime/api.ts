import { audit } from "../audit.ts";
import type { Env } from "../env.ts";
import { HttpError, readBody, requireConfiguredSecret } from "../http.ts";
import { resolveCurrentUser } from "../identity/index.ts";
import { hmacSha256, signJwt } from "../jwt.ts";
import { signAppsToken } from "../appsProxy/tokenSigner.ts";
import { createMatePreviewSessionApi } from "./service.ts";

export function createMateRuntimeServices() {
  return {
    matePreviewSessionApi: createMatePreviewSessionApi<Env>({
      audit,
      httpError: (status, code) => new HttpError(status, code),
      opaquePrincipalKey: (value, env) => hmacSha256(
        value,
        previewJwtSecret(env)
      ),
      readBody,
      resolveCurrentUser,
      signAppsToken,
      signRuntimeToken: (env, payload) => signJwt(
        payload,
        previewJwtSecret(env)
      )
    })
  };
}

function previewJwtSecret(env: Env) {
  const secret = requireConfiguredSecret(env.MATE_PREVIEW_JWT_SECRET, "mate_preview_jwt_secret");
  if (secret.length < 32) throw new HttpError(503, "mate_preview_jwt_secret_invalid");
  return secret;
}
