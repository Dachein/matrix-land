import type { Discussion } from "../../shared/types";
import type { TranslationKey } from "../i18n";
import {
  FORUM_CATEGORY_DEFINITIONS,
  FORUM_TOPIC_TYPE_DEFINITIONS,
  type ForumCategorySlug
} from "./config";

export type ForumTranslate = (key: TranslationKey, values?: Record<string, number | string | undefined>) => string;

export function forumTopicTypeLabel(topicType: Discussion["topicType"] | string | undefined, t: ForumTranslate) {
  const normalized = normalizeForumTopicType(topicType);
  const definition = normalized ? FORUM_TOPIC_TYPE_DEFINITIONS.find((item) => item.value === normalized) : undefined;
  return definition ? localizedForumLabel(definition, t) : "";
}

export function isAgentDiscussion(discussion: Discussion) {
  return discussion.source === "mcp";
}

export function buildCategorySummary(discussions: Discussion[], t: ForumTranslate) {
  const counts = new Map<ForumCategorySlug, number>();

  discussions.forEach((discussion) => {
    const category = forumDiscussionCategorySlug(discussion);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  });

  return FORUM_CATEGORY_DEFINITIONS.map((category) => ({
    count: counts.get(category.slug) ?? 0,
    name: localizedForumLabel(category, t),
    slug: category.slug
  }));
}

export function forumDiscussionCategorySlug(discussion: Discussion): ForumCategorySlug {
  return normalizeForumCategorySlug(discussion.categorySlug ?? discussion.category ?? discussion.tag);
}

export function forumDiscussionCategoryLabel(discussion: Discussion, t: ForumTranslate) {
  const slug = forumDiscussionCategorySlug(discussion);
  const definition = FORUM_CATEGORY_DEFINITIONS.find((category) => category.slug === slug) ?? FORUM_CATEGORY_DEFINITIONS[0];
  return localizedForumLabel(definition, t);
}

export function normalizeForumTopicType(value?: string): Discussion["topicType"] {
  if (value === "announcement") {
    return "official";
  }

  if (value === "support") {
    return "help";
  }

  return FORUM_TOPIC_TYPE_DEFINITIONS.some((item) => item.value === value) ? value as Discussion["topicType"] : undefined;
}

export function normalizeForumCategorySlug(value?: string): ForumCategorySlug {
  const normalized = (value ?? "").trim().toLowerCase();

  if (
    normalized === "ai-exploration" ||
    normalized === "ai exploration" ||
    normalized === "ai application exploration" ||
    normalized === "ai 探索" || // i18n-allow-cjk: legacy category alias, not UI copy
    normalized === "ai应用探索" || // i18n-allow-cjk: legacy category alias, not UI copy
    normalized === "ai 应用探索" || // i18n-allow-cjk: legacy category alias, not UI copy
    normalized === "use cases"
  ) {
    return "ai-exploration";
  }

  if (
    normalized === "ai-investment" ||
    normalized === "ai investment" ||
    normalized === "ai investment sharing" ||
    normalized === "ai 投资" || // i18n-allow-cjk: legacy category alias, not UI copy
    normalized === "ai投资分享" || // i18n-allow-cjk: legacy category alias, not UI copy
    normalized === "ai 投资分享" // i18n-allow-cjk: legacy category alias, not UI copy
  ) {
    return "ai-investment";
  }

  if (
    normalized === "off-topic" ||
    normalized === "off topic" ||
    normalized === "杂谈闲聊" || // i18n-allow-cjk: legacy category alias, not UI copy
    normalized === "杂谈与分享" || // i18n-allow-cjk: legacy category alias, not UI copy
    normalized === "chit-chat" ||
    normalized === "chit-chat & sharing"
  ) {
    return "off-topic";
  }

  if (
    normalized === "platform-help" ||
    normalized === "platform help" ||
    normalized === "platform usage" ||
    normalized === "平台使用" || // i18n-allow-cjk: legacy category alias, not UI copy
    normalized === "公告与建议" || // i18n-allow-cjk: legacy category alias, not UI copy
    normalized === "announcements" ||
    normalized === "announcements & suggestions" ||
    normalized === "q&a" ||
    normalized === "q-and-a" ||
    normalized === "app-launch" ||
    normalized === "app launch" ||
    normalized === "mcp-data-services" ||
    normalized === "mcp & data services" ||
    normalized === "skill-publishing" ||
    normalized === "skill publishing"
  ) {
    return "platform-help";
  }

  return "ai-exploration";
}

export function localizedForumLabel(label: { labelKey: TranslationKey }, t: ForumTranslate) {
  return t(label.labelKey);
}
