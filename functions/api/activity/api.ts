import { currentUserTeamId, resolveCurrentUser } from "../identity/index.ts";
import { requireDb } from "../http.ts";
import { createActivityApi } from "./service.ts";

export function createActivityServices() {
  return {
    activityApi: createActivityApi({
      currentUserTeamId,
      requireDb,
      resolveCurrentUser
    })
  };
}
