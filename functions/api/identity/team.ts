import type { CurrentUser, IdentityEnv } from "./types.ts";

export async function currentUserTeamId<TEnv extends IdentityEnv>(db: D1Database, currentUser: CurrentUser, env: TEnv) {
  const row = await db.prepare("SELECT team_id AS teamId FROM users WHERE id = ? LIMIT 1").bind(currentUser.id).first<{ teamId: string }>();
  return row?.teamId ?? env.DEFAULT_TEAM_ID ?? "team-ai-adoption";
}
