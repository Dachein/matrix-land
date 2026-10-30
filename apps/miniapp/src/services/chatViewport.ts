/** Keep the unoccluded window separate from Android keyboard-driven resize events. */
export interface ChatViewport {
  width: number;
  height: number;
  keyboardHeight: number;
}

export function resizeChatViewport(state: ChatViewport, width: number, height: number): ChatViewport {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return state;
  if (width !== state.width) return { width, height, keyboardHeight: 0 };
  // Some Android clients shrink windowHeight before (or after) the keyboard event.
  // Subtracting from that value would count the keyboard twice and lose the baseline.
  return height <= state.height ? state : { ...state, height };
}

export function updateChatKeyboard(state: ChatViewport, height: number): ChatViewport {
  if (!Number.isFinite(height) || height < 0 || height >= state.height) return state;
  return height === state.keyboardHeight ? state : { ...state, keyboardHeight: height };
}

export function visibleChatHeight(state: ChatViewport): number {
  return state.height - state.keyboardHeight;
}

export function composerLineCount(lines: number): number {
  return Number.isFinite(lines) ? Math.min(4, Math.max(1, Math.ceil(lines))) : 1;
}
