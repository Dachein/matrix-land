import { forumAnonymousPersona, normalizeForumAnonymousPersona } from "../../../src/portal/forum/forumAnonymousIdentity.ts";
import type { CurrentUser } from "./types.ts";

export function publicForumActor(currentUser: CurrentUser, personaKey: unknown): CurrentUser {
  const persona = forumAnonymousPersona(personaKey);

  if (!persona) {
    return currentUser;
  }

  return {
    ...currentUser,
    avatarUrl: persona.avatarUrl,
    email: "",
    id: "",
    name: persona.name,
    team: ""
  };
}

export async function existingForumAnonymousPersona(db: D1Database, topicId: string, userId: string) {
  const row = await db
    .prepare(
      `
      SELECT anonymous_persona AS anonymousPersona
      FROM forum_posts
      WHERE topic_id = ?
        AND author_user_id = ?
        AND is_anonymous = 1
        AND anonymous_persona IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 1
      `
    )
    .bind(topicId, userId)
    .first<{ anonymousPersona?: string }>();

  return normalizeForumAnonymousPersona(row?.anonymousPersona);
}
