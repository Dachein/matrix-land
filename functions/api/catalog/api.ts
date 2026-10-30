import type { Env } from "../env.ts";
import { currentUserTeamId } from "../identity/index.ts";
import { normalizeIdentityProvider, normalizeRole } from "../values.ts";
import { createCatalogApi } from "./service.ts";

export function createCatalogServices() {
  return {
    catalogApi: createCatalogApi<Env>({
      currentUserTeamId,
      normalizeIdentityProvider,
      normalizeRole
    })
  };
}
