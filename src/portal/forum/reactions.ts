import type { DiscussionReaction } from "../../shared/types";
import { FORUM_REACTION_DEFINITIONS, type ForumReactionValue } from "./config";

export type OptimisticReactionState = {
  currentUserReaction: string | undefined;
  likedByCurrentUser: boolean;
  likes: number;
  reactions: DiscussionReaction[];
};

type ReactionSource = {
  currentUserReaction?: string;
  likedByCurrentUser?: boolean;
  likes?: number;
  reactions?: DiscussionReaction[];
};

export function nextOptimisticReactionState(source: ReactionSource, reaction: ForumReactionValue): OptimisticReactionState {
  const previousReaction = source.currentUserReaction;
  const nextReaction = previousReaction === reaction ? undefined : reaction;
  const counts = reactionCounts(source.reactions, source.likes);

  if (previousReaction && !counts.has(previousReaction)) {
    counts.set(previousReaction, 1);
  }

  if (previousReaction) {
    counts.set(previousReaction, Math.max(0, (counts.get(previousReaction) ?? 0) - 1));
  }

  if (nextReaction) {
    counts.set(nextReaction, (counts.get(nextReaction) ?? 0) + 1);
  }

  const reactions = orderedReactions(counts);

  return {
    currentUserReaction: nextReaction,
    likedByCurrentUser: Boolean(nextReaction),
    likes: reactions.reduce((total, item) => total + item.count, 0),
    reactions
  };
}

export function reactionStateFromResponse(
  payload: { liked?: boolean; likes?: number; reaction?: string; reactions?: DiscussionReaction[] },
  fallback: OptimisticReactionState
): OptimisticReactionState {
  return {
    currentUserReaction: payload.liked === true ? payload.reaction : undefined,
    likedByCurrentUser: payload.liked === true,
    likes: Number.isFinite(payload.likes) ? Number(payload.likes) : fallback.likes,
    reactions: payload.reactions ?? fallback.reactions
  };
}

function reactionCounts(reactions: DiscussionReaction[] | undefined, total = 0) {
  const counts = new Map<string, number>();

  reactions?.forEach((reaction) => {
    counts.set(reaction.reaction, Math.max(0, reaction.count));
  });

  if (counts.size === 0 && total > 0) {
    counts.set("thumbsup", total);
  }

  return counts;
}

function orderedReactions(counts: Map<string, number>) {
  const knownValues = new Set(FORUM_REACTION_DEFINITIONS.map((reaction) => reaction.value));
  const orderedKeys = [
    ...FORUM_REACTION_DEFINITIONS.map((reaction) => reaction.value),
    ...Array.from(counts.keys()).filter((reaction) => !knownValues.has(reaction as ForumReactionValue))
  ];

  return orderedKeys
    .map((reaction) => ({ reaction, count: counts.get(reaction) ?? 0 }))
    .filter((reaction): reaction is DiscussionReaction => reaction.count > 0);
}
