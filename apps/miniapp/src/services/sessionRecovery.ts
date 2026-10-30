import type { Conversation, LiveSession, Mate } from "../types";

export const SESSION_REFRESH_WINDOW_MS = 60_000;

export function shouldRefreshSession(session: LiveSession, now = Date.now()) {
  const expiresAt = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt - now <= SESSION_REFRESH_WINDOW_MS;
}

export function isRuntimeSessionInvalid(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; status?: unknown };
  return candidate.code === "runtime_token_invalid"
    || candidate.message === "runtime_token_invalid"
    || (candidate.status === 401 && candidate.code === "runtime_token_invalid");
}

/** True when the runtime token is missing, unparseable, or about to lapse. */
export function isRuntimeSessionExpired(session: LiveSession, now = Date.now(), skewMs = 30_000) {
  const expiresAt = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt - now <= skewMs;
}

/** The sessions API may omit mate details; hydrate them from the selected Mate. */
export function hydrateSessionMate(
  session: Omit<LiveSession, "mate"> & { mate?: Partial<Mate> },
  mate: Mate
): LiveSession {
  return { ...session, mate: { ...mate, ...session.mate } };
}

/**
 * Reuses a runtime session for a different conversation of the same Mate. The token,
 * principal and expiry are runtime-level concerns, so only conversation identity moves.
 * Callers must pass a conversation belonging to the session's Mate (see `Conversation`).
 */
export function reuseRuntimeSession(session: LiveSession, conversation: Conversation): LiveSession {
  return {
    ...session,
    conversationId: conversation.id,
    conversationState: "persisted"
  };
}
