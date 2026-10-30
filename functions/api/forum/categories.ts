import type { Discussion } from "../../../src/shared/types.ts";
import type { ForumDeps, ForumEnv } from "./types.ts";
import { readString } from "./utils.ts";

export async function defaultForumCategoryId<TEnv extends ForumEnv>(db: D1Database, deps: ForumDeps<TEnv>) {
  const row = await db.prepare("SELECT id FROM forum_categories ORDER BY sort_order, name LIMIT 1").first<{ id: string }>();

  if (!row) {
    throw deps.httpError(400, "missing_forum_category");
  }

  return row.id;
}

export async function forumCategoryIdForSlug(db: D1Database, slug?: string) {
  if (!slug) {
    return undefined;
  }

  const row = await db.prepare("SELECT id FROM forum_categories WHERE slug = ? LIMIT 1").bind(slug).first<{ id: string }>();
  return row?.id;
}

export async function defaultForumCategoryIdForTopicType<TEnv extends ForumEnv>(
  db: D1Database,
  topicType: Discussion["topicType"],
  deps: ForumDeps<TEnv>
) {
  const slug =
    topicType === "help" || topicType === "question" || topicType === "official" || topicType === "release"
      ? "platform-help"
      : "ai-exploration";

  const row = await db.prepare("SELECT id FROM forum_categories WHERE slug = ? LIMIT 1").bind(slug).first<{ id: string }>();

  if (row) {
    return row.id;
  }

  return defaultForumCategoryId(db, deps);
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
