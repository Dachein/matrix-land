import type { PeopleMentionCandidate } from "../../components/PeopleMentionPicker";

export type ForumMentionCandidate = PeopleMentionCandidate & {
  email: string;
  emailPrefix: string;
};

type ForumMentionProps = {
  avatarUrl: string;
  email: string;
  emailPrefix: string;
  id: string;
  name: string;
};

const MENTION_TEXT_PATTERN = /(^|[\s([{"'，。！？、:：;；])@([a-zA-Z0-9._-]{1,64})/g;

export function mentionPropsForCandidate(person: ForumMentionCandidate): ForumMentionProps {
  return {
    avatarUrl: person.avatarUrl ?? "",
    email: person.email,
    emailPrefix: person.emailPrefix,
    id: person.id,
    name: person.name
  };
}

export async function searchForumMentionCandidates(query: string): Promise<ForumMentionCandidate[]> {
  const params = new URLSearchParams();
  params.set("limit", "8");
  params.set("purpose", "mention");
  params.set("q", query);
  params.append("status", "active");
  params.append("status", "invited");
  const response = await fetch(`/api/users/directory?${params.toString()}`);
  if (!response.ok) throw new Error("mention_search_failed");

  const payload = await response.json() as { users?: Array<Record<string, unknown>> };
  return (payload.users ?? []).flatMap(readMentionCandidate);
}

/**
 * Converts plain `@prefix` text runs inside parsed blocks into mention inline
 * content so that existing markdown renders as interactive chips in the editor.
 */
export function resolveMentionsInBlocks<T>(blocks: T[], candidatesByPrefix: ReadonlyMap<string, ForumMentionCandidate>): T[] {
  if (candidatesByPrefix.size === 0) return blocks;
  return blocks.map((block) => resolveMentionsInBlock(block, candidatesByPrefix));
}

function resolveMentionsInBlock<T>(block: T, candidatesByPrefix: ReadonlyMap<string, ForumMentionCandidate>): T {
  if (!block || typeof block !== "object") return block;

  const source = block as Record<string, unknown>;
  const next: Record<string, unknown> = { ...source };

  if (Array.isArray(source.content)) {
    next.content = source.content.flatMap((item) => resolveInlineContentMentions(item, candidatesByPrefix));
  }

  if (Array.isArray(source.children)) {
    next.children = source.children.map((child) => resolveMentionsInBlock(child, candidatesByPrefix));
  }

  return next as T;
}

function resolveInlineContentMentions(item: unknown, candidatesByPrefix: ReadonlyMap<string, ForumMentionCandidate>): unknown[] {
  if (!item || typeof item !== "object") return [item];

  const inline = item as { type?: string; text?: string; styles?: Record<string, unknown> };
  if (inline.type !== "text" || typeof inline.text !== "string" || !inline.text.includes("@")) {
    return [item];
  }

  const parts: unknown[] = [];
  let lastIndex = 0;

  const pushText = (text: string) => {
    if (text) parts.push({ type: "text", text, styles: inline.styles ?? {} });
  };

  for (const match of inline.text.matchAll(MENTION_TEXT_PATTERN)) {
    const boundary = match[1];
    const rawPrefix = match[2];
    const resolvedPrefix = rawPrefix.replace(/[._-]+$/g, "");
    const mention = candidatesByPrefix.get(resolvedPrefix.toLowerCase());
    if (!mention) continue;

    const mentionStart = (match.index ?? 0) + boundary.length;
    pushText(inline.text.slice(lastIndex, mentionStart));
    parts.push({ type: "mention", props: mentionPropsForCandidate(mention) });
    pushText(rawPrefix.slice(resolvedPrefix.length));
    lastIndex = mentionStart + rawPrefix.length + 1;
  }

  if (parts.length === 0) return [item];
  pushText(inline.text.slice(lastIndex));
  return parts;
}

function readMentionCandidate(value: Record<string, unknown>): ForumMentionCandidate[] {
  const id = readString(value.id);
  const email = readString(value.email);
  const emailPrefix = readString(value.emailPrefix) || email.split("@")[0];

  if (!id || !email || !emailPrefix) return [];

  return [{
    avatarUrl: readString(value.avatarUrl) || undefined,
    email,
    emailPrefix,
    id,
    name: readString(value.name) || email
  }];
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
