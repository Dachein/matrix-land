import type { ForumListedItemAttachment, LinkedForumFilter } from "./types";

export function readForumTopicId() {
  const hashPath = window.location.hash.replace(/^#/, "");
  const match = hashPath.match(/^\/community\/([^/?]+)(?:\?.*)?$/);
  return match?.[1];
}

const VIEWED_FORUM_TOPIC_SESSION_KEY = "workspace_viewed_forum_topic_ids";

export function readViewedForumTopicIds() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(VIEWED_FORUM_TOPIC_SESSION_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function rememberViewedForumTopicId(topicId: string) {
  try {
    const viewedIds = new Set(readViewedForumTopicIds());
    viewedIds.add(topicId);
    window.sessionStorage.setItem(VIEWED_FORUM_TOPIC_SESSION_KEY, JSON.stringify([...viewedIds].slice(-240)));
  } catch {
    // Session storage only de-duplicates views inside the current browser session.
  }
}

export function forgetViewedForumTopicId(topicId: string) {
  try {
    const viewedIds = readViewedForumTopicIds().filter((id) => id !== topicId);
    window.sessionStorage.setItem(VIEWED_FORUM_TOPIC_SESSION_KEY, JSON.stringify(viewedIds));
  } catch {
    // Ignore storage failures.
  }
}

export function readForumListQuery() {
  const hashPath = window.location.hash.replace(/^#/, "");
  const queryIndex = hashPath.indexOf("?");

  if (!hashPath.startsWith("/community") || queryIndex === -1) {
    return "";
  }

  const params = new URLSearchParams(hashPath.slice(queryIndex + 1));
  return params.get("q") ?? params.get("linkedId") ?? "";
}

export function readForumLinkedFilter(): LinkedForumFilter | undefined {
  const hashPath = window.location.hash.replace(/^#/, "");
  const queryIndex = hashPath.indexOf("?");

  if (!hashPath.startsWith("/community") || queryIndex === -1) {
    return undefined;
  }

  const params = new URLSearchParams(hashPath.slice(queryIndex + 1));
  const type = params.get("linkedType");
  const id = params.get("linkedId");
  const label = params.get("q");

  if ((type !== "app" && type !== "skill" && type !== "mcp") || !id) {
    return undefined;
  }

  return { id, label: label ?? "", type };
}

export function readForumComposeIntent(): ForumListedItemAttachment | undefined {
  const hashPath = window.location.hash.replace(/^#/, "");
  const queryIndex = hashPath.indexOf("?");

  if (!hashPath.startsWith("/community") || queryIndex === -1) {
    return undefined;
  }

  const params = new URLSearchParams(hashPath.slice(queryIndex + 1));

  if (params.get("compose") !== "1") {
    return undefined;
  }

  const type = params.get("linkedType");
  const id = params.get("linkedId");
  const label = params.get("q") ?? params.get("linkedName") ?? "";

  if ((type !== "app" && type !== "skill" && type !== "mcp") || !id) {
    return undefined;
  }

  return {
    category: params.get("category") ?? undefined,
    description: params.get("description") ?? undefined,
    iconUrl: params.get("iconUrl") ?? undefined,
    id,
    installs: Number(params.get("installs") ?? "") || undefined,
    label,
    owner: params.get("owner") ?? undefined,
    type
  };
}
