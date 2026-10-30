import type { Discussion } from "../../shared/types";
import type { ForumDiscussion } from "./forumAnonymousIdentity";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ForumTopicRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`forum_topic_request_${status}`);
    this.status = status;
  }
}

export async function readForumTopic(
  topicId: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch
) {
  const response = await fetchImpl(`/api/forum/topics/${encodeURIComponent(topicId)}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal
  });

  if (!response.ok) {
    throw new ForumTopicRequestError(response.status);
  }

  return forumDiscussionFromPayload(await response.json());
}

export function forumDiscussionFromPayload(payload: unknown): ForumDiscussion {
  const discussion = isRecord(payload) && isRecord(payload.discussion)
    ? payload.discussion
    : undefined;

  if (!discussion || typeof discussion.id !== "string" || !discussion.id) {
    throw new ForumTopicRequestError(502);
  }

  return discussion as ForumDiscussion;
}

export function upsertForumDiscussion(
  discussions: Discussion[],
  discussion: Discussion,
  options: { prepend?: boolean } = {}
) {
  const existingIndex = discussions.findIndex((item) => item.id === discussion.id);

  if (existingIndex >= 0) {
    return discussions.map((item, index) => index === existingIndex ? discussion : item);
  }

  return options.prepend ? [discussion, ...discussions] : [...discussions, discussion];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
