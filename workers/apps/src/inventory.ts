import type { Env, Principal } from "./core/types";
import { listApps } from "./apps/queries";
import { listManagedSkills } from "./skills/service";
import { listMates } from "./mates/service";

export async function listManagedInventory(env: Env, principal: Principal) {
  const canReadMates = principal.scopes.includes("apps:*")
    || principal.scopes.some((scope) => ["apps:mates:read", "apps:mates:write", "apps:mates:admin"].includes(scope));
  const [apps, skills, mates] = await Promise.all([
    listApps(env.APPS_DB, env, principal),
    listManagedSkills(env.APPS_DB, principal),
    canReadMates ? listMates(env.APPS_DB, principal) : Promise.resolve([])
  ]);

  return { apps, skills, mates };
}
