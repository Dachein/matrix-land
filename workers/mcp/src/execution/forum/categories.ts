import { readString } from "../../http.ts";
import { ensureDefaultTeam } from "./identity.ts";

export async function listForumCategories(db: D1Database) {
  const rows = await db
    .prepare(
      `
      SELECT id, name, slug, description, sort_order AS sortOrder
      FROM forum_categories
      ORDER BY sort_order ASC, name ASC
      `
    )
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

export function normalizeTopicType(value: unknown) {
  const type = readString(value).trim().toLowerCase().replaceAll("_", "-");

  if (type === "announcement") {
    return "official";
  }

  if (type === "support" || type === "q-and-a" || type === "q&a") {
    return "help";
  }

  return type === "help" || type === "question" || type === "showcase" || type === "idea" || type === "official" || type === "release"
    ? type
    : "question";
}

export function normalizeForumCategorySlug(value: unknown) {
  const slug = readString(value).trim().toLowerCase();

  if (
    slug === "ai-exploration"
    || slug === "ai exploration"
    || slug === "ai application exploration"
    || slug === "ai 探索"
    || slug === "ai应用探索"
    || slug === "ai 应用探索"
    || slug === "use-cases"
  ) {
    return "ai-exploration";
  }

  if (
    slug === "ai-investment"
    || slug === "ai investment"
    || slug === "ai investment sharing"
    || slug === "ai 投资"
    || slug === "ai投资分享"
    || slug === "ai 投资分享"
  ) {
    return "ai-investment";
  }

  if (
    slug === "off-topic"
    || slug === "off topic"
    || slug === "杂谈闲聊"
    || slug === "杂谈与分享"
    || slug === "chit-chat"
    || slug === "chit-chat & sharing"
  ) {
    return "off-topic";
  }

  if (
    slug === "platform-help"
    || slug === "platform help"
    || slug === "platform usage"
    || slug === "平台使用"
    || slug === "公告与建议"
    || slug === "announcements"
    || slug === "announcements & suggestions"
    || slug === "q&a"
    || slug === "q-and-a"
    || slug === "app-launch"
    || slug === "app launch"
    || slug === "mcp-data-services"
    || slug === "mcp & data services"
    || slug === "skill-publishing"
    || slug === "skill publishing"
  ) {
    return "platform-help";
  }

  return undefined;
}

export async function forumCategoryIdForSlug(db: D1Database, slug: string) {
  const row = await db.prepare("SELECT id FROM forum_categories WHERE slug = ? LIMIT 1").bind(slug).first<{ id: string }>();
  if (row) {
    return row.id;
  }

  return await defaultForumCategoryId(db);
}

export async function defaultForumCategoryIdForTopicType(db: D1Database, topicType: string) {
  const slug =
    topicType === "help" || topicType === "question" || topicType === "official" || topicType === "release"
      ? "platform-help"
      : "ai-exploration";
  const row = await db.prepare("SELECT id FROM forum_categories WHERE slug = ? LIMIT 1").bind(slug).first<{ id: string }>();

  if (row) {
    return row.id;
  }

  return await defaultForumCategoryId(db);
}

async function defaultForumCategoryId(db: D1Database) {
  const row = await db
    .prepare("SELECT id FROM forum_categories ORDER BY sort_order ASC, name ASC LIMIT 1")
    .first<{ id: string }>();

  if (row) {
    return row.id;
  }

  await ensureDefaultTeam(db);
  await db
    .prepare(
      `
      INSERT OR IGNORE INTO forum_categories (id, name, slug, description, owner_team_id, sort_order)
      VALUES ('forum-platform-help', '公告与建议', 'platform-help', 'Announcements, suggestions, platform feedback, and official updates.', 'team-ai-adoption', 30)
      `
    )
    .run();
  return "forum-platform-help";
}
