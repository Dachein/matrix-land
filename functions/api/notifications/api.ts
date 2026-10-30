import { readBody, requireDb } from "../http.ts";
import { resolveCurrentUser } from "../identity/index.ts";
import { createNotificationsApi } from "./service.ts";

export function createNotificationsServices() {
  return {
    notificationsApi: createNotificationsApi({
      readBody,
      requireDb,
      resolveCurrentUser
    })
  };
}
