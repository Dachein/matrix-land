import type { ForumEnv } from "./types.ts";
import { loadUserDirectoryUsers, type UserDirectoryEntry } from "../users/directory.ts";

export function parseMentionPrefixes(value: string) {
  return Array.from(value.matchAll(/(?:^|[\s([{"'，。！？、:：;；])@([a-zA-Z0-9._-]{1,64})/g), (match) =>
    match[1].replace(/[._-]+$/g, "").toLowerCase()
  ).filter(Boolean);
}

export async function resolveMentionTargets(db: D1Database, prefixes: string[], env?: ForumEnv) {
  const uniquePrefixes = Array.from(new Set(prefixes));
  const mentions: { userId: string; text: string }[] = [];

  for (const prefix of uniquePrefixes) {
    const matches = env
      ? await resolveDirectoryMentionMatches(db, env, prefix)
      : undefined;
    const fallbackMatches = matches ?? await resolvePortalMentionMatches(db, prefix);

    if (fallbackMatches.length === 1) {
      mentions.push({ userId: fallbackMatches[0].id, text: `@${prefix}` });
    }
  }

  return mentions;
}

export function mentionRecipientUserIds(
  mentions: Array<{ userId: string }>,
  actorUserId: string,
  excludedUserIds: Iterable<string> = []
) {
  const excluded = new Set(excludedUserIds);
  return Array.from(new Set(
    mentions
      .map((mention) => mention.userId.trim())
      .filter((userId) => userId && userId !== actorUserId && !excluded.has(userId))
  ));
}

async function resolveDirectoryMentionMatches(db: D1Database, env: ForumEnv, prefix: string) {
  const directoryUsers = await loadUserDirectoryUsers(env, {
    limit: 24,
    q: prefix,
    statuses: ["active", "invited"]
  });

  if (!directoryUsers) {
    return undefined;
  }

  const exactPrefixMatches = directoryUsers.filter((user) => user.emailPrefix.toLowerCase() === prefix);
  const portalUsers = await ensureForumMentionUsers(db, env, exactPrefixMatches);

  return portalUsers.map((user) => ({ id: user.id }));
}

async function ensureForumMentionUsers(db: D1Database, env: ForumEnv, users: UserDirectoryEntry[]) {
  const resolvedUsers: UserDirectoryEntry[] = [];

  for (const user of users) {
    const email = user.email.trim().toLowerCase();
    if (!user.id || !email) continue;

    const existing = await findPortalMentionUser(db, user.id, email);
    const status = user.status === "invited" ? "invited" : "active";

    if (existing?.id) {
      await db
        .prepare(
          `
          UPDATE users
          SET name = ?, status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `
        )
        .bind(user.name || email, status, existing.id)
        .run();
      resolvedUsers.push({ ...user, id: existing.id, status });
      continue;
    }

    const teamId = env.DEFAULT_TEAM_ID?.trim() || "team-ai-adoption";
    await db
      .prepare(
        `
        INSERT OR IGNORE INTO users (id, team_id, name, email, role, status)
        SELECT ?, teams.id, ?, ?, 'member', ?
        FROM teams
        WHERE teams.id = ?
        LIMIT 1
        `
      )
      .bind(user.id, user.name || email, email, status, teamId)
      .run();

    const inserted = await findPortalMentionUser(db, user.id, email);
    if (inserted?.id) {
      resolvedUsers.push({ ...user, id: inserted.id, status });
    }
  }

  return resolvedUsers;
}

async function findPortalMentionUser(db: D1Database, userId: string, email: string) {
  return db
    .prepare(
      `
      SELECT id
      FROM users
      WHERE id = ? OR LOWER(email) = ?
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
      LIMIT 1
      `
    )
    .bind(userId, email, userId)
    .first<{ id: string }>();
}

async function resolvePortalMentionMatches(db: D1Database, prefix: string) {
  const matches = await db
    .prepare(
      `
      SELECT id
      FROM users
      WHERE status = 'active'
        AND lower(substr(email, 1, instr(email, '@') - 1)) = ?
      ORDER BY email
      LIMIT 2
      `
    )
    .bind(prefix)
    .all<{ id: string }>();

  return matches.results ?? [];
}
