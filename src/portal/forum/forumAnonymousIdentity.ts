import type { Discussion, DiscussionReply } from "../../shared/types";

export const FORUM_ANONYMOUS_PERSONAS = [
  {
    avatarUrl: "/assets/forum-anonymous/morning-owl.png",
    descriptionEn: "Observant and thoughtful",
    descriptionZh: "沉静、善于观察",
    key: "morning-owl",
    name: "Morning Owl",
    nameZh: "晨曦猫头鹰"
  },
  {
    avatarUrl: "/assets/forum-anonymous/curious-fox.png",
    descriptionEn: "Clever and curious",
    descriptionZh: "聪明、喜欢探索",
    key: "curious-fox",
    name: "Curious Fox",
    nameZh: "好奇狐狸"
  },
  {
    avatarUrl: "/assets/forum-anonymous/morning-lark.png",
    descriptionEn: "Positive and energetic",
    descriptionZh: "积极、充满朝气",
    key: "morning-lark",
    name: "Morning Lark",
    nameZh: "晨光云雀"
  },
  {
    avatarUrl: "/assets/forum-anonymous/bright-otter.png",
    descriptionEn: "Bright, friendly, and lively",
    descriptionZh: "聪慧、友好、有活力",
    key: "bright-otter",
    name: "Bright Otter",
    nameZh: "灵动水獭"
  },
  {
    avatarUrl: "/assets/forum-anonymous/rising-finch.png",
    descriptionEn: "Growing and reaching upward",
    descriptionZh: "成长、向上",
    key: "rising-finch",
    name: "Rising Finch",
    nameZh: "振翅雀"
  }
] as const;

export type ForumAnonymousPersona = (typeof FORUM_ANONYMOUS_PERSONAS)[number]["key"];

export type ForumDiscussionReply = DiscussionReply & {
  anonymous?: boolean;
  anonymousPersona?: ForumAnonymousPersona;
  ownedByCurrentUser?: boolean;
};

export type ForumDiscussion = Omit<Discussion, "replyPosts"> & {
  anonymous?: boolean;
  anonymousPersona?: ForumAnonymousPersona;
  currentUserAnonymousPersona?: ForumAnonymousPersona;
  ownedByCurrentUser?: boolean;
  replyPosts?: ForumDiscussionReply[];
};

export const DEFAULT_FORUM_ANONYMOUS_PERSONA: ForumAnonymousPersona = "morning-owl";

export function randomForumAnonymousPersona(exclude?: ForumAnonymousPersona): ForumAnonymousPersona {
  const candidates = exclude
    ? FORUM_ANONYMOUS_PERSONAS.filter((persona) => persona.key !== exclude)
    : FORUM_ANONYMOUS_PERSONAS;
  const randomIndex = typeof crypto !== "undefined" && "getRandomValues" in crypto
    ? crypto.getRandomValues(new Uint32Array(1))[0] % candidates.length
    : Math.floor(Math.random() * candidates.length);

  return candidates[randomIndex]?.key ?? DEFAULT_FORUM_ANONYMOUS_PERSONA;
}

export function forumAnonymousPersona(value: unknown) {
  return FORUM_ANONYMOUS_PERSONAS.find((persona) => persona.key === value);
}

export function normalizeForumAnonymousPersona(value: unknown): ForumAnonymousPersona | undefined {
  return forumAnonymousPersona(value)?.key;
}
