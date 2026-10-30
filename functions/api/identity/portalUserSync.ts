import { HttpError } from "../http.ts";
import {
  findUserIdByEmail,
  findUserIdByIdentity,
  insertUserIfMissing,
  readPortalCurrentUser,
  updateLastSeenAt,
  upsertIdentityProfile
} from "./portalUserRepository.ts";
import type { AuthPrincipal, CurrentUser, IdentityEnv } from "./types.ts";

export async function syncPortalCurrentUser<TEnv extends IdentityEnv>(
  db: D1Database,
  principal: AuthPrincipal,
  fallbackUser: CurrentUser,
  env: TEnv
): Promise<CurrentUser> {
  const existingProfileUserId = await findUserIdByIdentity(db, principal);
  const existingUserId = existingProfileUserId ? undefined : await findUserIdByEmail(db, principal.email);
  const userId = existingProfileUserId ?? existingUserId ?? fallbackUser.id;

  if (!existingProfileUserId) {
    await insertUserIfMissing(db, userId, principal, env);
  }

  await updateLastSeenAt(db, userId, principal.email);
  await upsertIdentityProfile(db, userId, principal);

  const currentUser = await readPortalCurrentUser(db, userId, fallbackUser);

  if (!currentUser) {
    return fallbackUser;
  }

  await assertActiveUser(db, userId);

  return currentUser;
}

async function assertActiveUser(db: D1Database, userId: string) {
  const row = await db
    .prepare("SELECT status FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ status: string }>();

  if (String(row?.status ?? "active") !== "active") {
    throw new HttpError(403, "user_inactive");
  }
}
