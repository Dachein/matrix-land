import type { Env } from "../env.ts";
import { resolveCurrentUser } from "../identity/index.ts";
import { requireConfiguredSecret } from "../http.ts";
import { signJwt } from "../jwt.ts";
import { createBackupProxyApi } from "./proxy.ts";

export function createBackupServices() {
  return {
    backupProxyApi: createBackupProxyApi<Env>({
      resolveCurrentUser,
      signBackupToken: (env, payload) => signJwt(payload, requireConfiguredSecret(env.BACKUP_PORTAL_JWT_SECRET, "backup_portal_jwt_secret"))
    })
  };
}
