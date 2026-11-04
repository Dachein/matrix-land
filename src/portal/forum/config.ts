import type { Discussion } from "../../shared/types";
import type { TranslationKey } from "../i18n";

export const MAX_FORUM_ATTACHMENTS = 16;
export const MAX_FORUM_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_FORUM_BODY_LENGTH = 8000;
export const FORUM_TOPIC_INITIAL_LIMIT = 12;
export const FORUM_TOPIC_LOAD_STEP = 8;

export const FORUM_CATEGORY_DEFINITIONS = [
  { slug: "ai-exploration", labelKey: "forum.category.aiExploration" },
  { slug: "ai-investment", labelKey: "forum.category.aiInvestment" },
  { slug: "platform-help", labelKey: "forum.category.platformHelp" },
  { slug: "off-topic", labelKey: "forum.category.offTopic" }
] as const satisfies ReadonlyArray<{ slug: string; labelKey: TranslationKey }>;

export const FORUM_REACTION_DEFINITIONS = [
  { value: "thumbsup", iconSrc: "/assets/reactions/fluent-flat/thumbs-up.svg", labelKey: "forum.reaction.thumbsup", color: "var(--fw-color-warning)", background: "var(--fw-color-warning-soft)" },
  { value: "eyes", iconSrc: "/assets/reactions/fluent-flat/eyes.svg", labelKey: "forum.reaction.eyes", color: "var(--fw-color-info)", background: "var(--fw-color-info-soft)" },
  { value: "tada", iconSrc: "/assets/reactions/fluent-flat/party-popper.svg", labelKey: "forum.reaction.tada", color: "var(--fw-color-data-violet)", background: "var(--fw-color-accent-soft)" },
  { value: "heart", iconSrc: "/assets/reactions/fluent-flat/red-heart.svg", labelKey: "forum.reaction.heart", color: "var(--fw-color-danger)", background: "var(--fw-color-danger-soft)" },
  { value: "bulb", iconSrc: "/assets/reactions/fluent-flat/light-bulb.svg", labelKey: "forum.reaction.bulb", color: "var(--fw-color-warning)", background: "var(--fw-color-warning-soft)" }
] as const satisfies ReadonlyArray<{
  background: string;
  color: string;
  iconSrc: string;
  labelKey: TranslationKey;
  value: string;
}>;

export const FORUM_TOPIC_TYPE_DEFINITIONS = [
  { value: "help", labelKey: "forum.topicType.help" },
  { value: "question", labelKey: "forum.topicType.question" },
  { value: "idea", labelKey: "forum.topicType.idea" },
  { value: "showcase", labelKey: "forum.topicType.showcase" },
  { value: "official", labelKey: "forum.topicType.official" },
  { value: "release", labelKey: "forum.topicType.release" }
] as const satisfies ReadonlyArray<{ value: NonNullable<Discussion["topicType"]>; labelKey: TranslationKey }>;

export type ForumCategorySlug = (typeof FORUM_CATEGORY_DEFINITIONS)[number]["slug"];
export type ForumReactionValue = (typeof FORUM_REACTION_DEFINITIONS)[number]["value"];
export type ForumTopicTypeValue = NonNullable<Discussion["topicType"]> | "";
