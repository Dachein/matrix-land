import type { Env } from "../env.ts";
import { audit } from "../audit.ts";
import { readBody } from "../http.ts";
import { currentUserTeamId, resolveCurrentUser } from "../identity/index.ts";
import { getTtlSeconds } from "../values.ts";
import { createAppsProxyApi } from "./proxy.ts";
import { createAppsTokenApi } from "./token.ts";
import { signAppsToken } from "./tokenSigner.ts";

export function createAppsServices() {
  return {
    appsProxyApi: createAppsProxyApi<Env>({
      currentUserTeamId,
      getTtlSeconds,
      resolveCurrentUser,
      signAppsToken
    }),
    appsTokenApi: createAppsTokenApi<Env>({
      audit,
      getTtlSeconds,
      readBody,
      resolveCurrentUser,
      signAppsToken
    })
  };
}
