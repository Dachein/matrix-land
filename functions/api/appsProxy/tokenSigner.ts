import type { Env } from "../env.ts";
import { requireConfiguredSecret } from "../http.ts";
import { signJwt } from "../jwt.ts";

export async function signAppsToken(env: Env, payload: Record<string, unknown>) {
  return signJwt(payload, requireConfiguredSecret(env.APPS_JWT_SECRET, "apps_jwt_secret"));
}
