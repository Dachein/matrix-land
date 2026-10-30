import { emitActivityEvent } from "../activity/service.ts";
import { audit } from "../audit.ts";
import { HttpError, readBody, requireDb } from "../http.ts";
import { excerpt, sanitizeTags } from "../portalContent.ts";
import { currentUserTeamId, resolveCurrentUser } from "../identity/index.ts";
import { requireText } from "../values.ts";
import { userProfileColumns } from "../catalog/service.ts";
import { recomputePortalUserJourney } from "../journey/service.ts";
import { createForumApi } from "./service.ts";
import type { Env } from "../env.ts";

export function createForumServices() {
  return {
    forumApi: createForumApi<Env>({
      audit,
      currentUserTeamId,
      emitActivityEvent,
      excerpt,
      httpError: (status, message) => new HttpError(status, message),
      readBody,
      refreshUserJourneyState: (db, userId, publishContext) => recomputePortalUserJourney(db, userId, {
        emitActivityEvent: (activityDb, input) => emitActivityEvent(activityDb, input, publishContext)
      }),
      requireDb,
      requireText,
      resolveCurrentUser,
      sanitizeTags,
      userProfileColumns
    })
  };
}
