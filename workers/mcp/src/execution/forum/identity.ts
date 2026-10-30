import { readString } from "../../http.ts";
import { ensureMcpLiteLlmUser } from "../../llmGateway.ts";
import type { Env, Principal } from "../../types.ts";

export function mcpForumActorName(principal: Principal) {
  const name = readString(principal.name).trim();
  if (name) {
    return name;
  }
  const emailName = readString(principal.email).trim().split("@")[0];
  return emailName || readString(principal.sub).trim() || "Agent";
}

export async function ensureForumUser(env: Env, principal: Principal) {
  const db = env.DB;
  const email = (principal.email ?? `${principal.sub}@mcp.workspace.local`).trim().toLowerCase().slice(0, 240);
  const name = (principal.name ?? email.split("@")[0] ?? principal.sub).trim().slice(0, 240);
  const role = (principal.role ?? "member").trim().slice(0, 80);
  const existing = await db
    .prepare(
      `
      SELECT id, team_id AS teamId
      FROM users
      WHERE id = ? OR lower(email) = lower(?)
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
      LIMIT 1
      `
    )
    .bind(principal.sub, email, principal.sub)
    .first<{ id: string; teamId: string }>();

  if (existing) {
    await db
      .prepare(
        `
        UPDATE users
        SET name = COALESCE(NULLIF(?, ''), name),
            last_seen_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `
      )
      .bind(name, existing.id)
      .run();
    return existing;
  }

  await ensureMcpLiteLlmUser(env, principal, email);
  await ensureDefaultTeam(db);
  await db
    .prepare(
      `
      INSERT INTO users (id, team_id, name, email, role, last_seen_at)
      VALUES (?, 'team-ai-adoption', ?, ?, ?, CURRENT_TIMESTAMP)
      `
    )
    .bind(principal.sub, name, email, role)
    .run();

  return { id: principal.sub, teamId: "team-ai-adoption" };
}

export async function ensureDefaultTeam(db: D1Database) {
  await db
    .prepare(
      `
      INSERT OR IGNORE INTO teams (id, name, slug)
      VALUES ('team-ai-adoption', 'AI Adoption', 'ai-adoption')
      `
    )
    .run();
}
