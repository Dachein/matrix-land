import type { MatePreviewSession } from "./api";

export const CHAT_ABSENCE_THRESHOLD_MS = 30 * 60_000;

export function isRuntimeAuthenticationError(code: string) {
  return /^(runtime_token_(invalid|expired|missing|required)|(runtime|mate_chat|chat)_grant_(invalid|expired|binding_changed)|unauthorized|authentication_required|preview_token_(invalid|expired))$/.test(code);
}

/** One refresh shared by concurrent SDK, attachment, approval, and profile reads. */
export function createChatCredentialManager(initial: MatePreviewSession, refresh: (session: MatePreviewSession) => Promise<MatePreviewSession>) {
  let current = initial;
  let refreshing: Promise<string> | undefined;
  return {
    session: () => current,
    accessToken: async () => {
      if (Date.parse(current.expiresAt) > Date.now() + 30_000) return current.accessToken;
      if (!refreshing) {
        const original = current;
        refreshing = refresh(original).then((next) => {
          if (next.conversationId !== original.conversationId || next.principalKey !== original.principalKey
            || next.runtimeOrigin !== original.runtimeOrigin || next.mate.id !== original.mate.id
            || next.release.id !== original.release.id || next.mode !== original.mode
            || !next.surface.entries.some((entry) => entry.channel === "sdk" && entry.kind === "conversation")) {
            throw new Error("preview_session_refresh_mismatch");
          }
          current = next;
          return current.accessToken;
        }).finally(() => { refreshing = undefined; });
      }
      return refreshing;
    }
  };
}

/** Focus events alone should never interrupt a recently active user. */
export function longChatAbsence(input: { now: number; awayAt?: number; lastHeartbeat: number }) {
  return input.now - (input.awayAt ?? input.lastHeartbeat) >= CHAT_ABSENCE_THRESHOLD_MS;
}

/** Bound recovery even when a fetch implementation ignores AbortSignal. */
export async function withChatRecoveryTimeout<T>(request: (signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const deadline = new Promise<T>((_resolve, reject) => {
    cancel = () => { controller.abort(); reject(new Error("runtime_session_recovery_cancelled")); };
    if (parentSignal?.aborted) { cancel(); return; }
    parentSignal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new Error("runtime_session_recovery_timeout")); }, timeoutMs);
  });
  try { return await Promise.race([request(controller.signal), deadline]); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancel) parentSignal?.removeEventListener("abort", cancel);
  }
}
