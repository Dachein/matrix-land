import type { ChatMessage } from '../types';

export const MESSAGE_RENDER_LIMIT = 10;
export const MESSAGE_RENDER_STEP = 20;
export const MESSAGE_RENDER_MAX = 30;
export type MessageWindowCursor = { firstId: string; count: number };
export type MessageWindow = {
  messages: ChatMessage[];
  hiddenCount: number;
  newerCount: number;
  start: number;
};

/** A bounded, overlapping history window. IDs keep the reader stable as live replies arrive. */
export function windowMessages(messages: ChatMessage[], cursor?: MessageWindowCursor): MessageWindow {
  const index = cursor ? messages.findIndex(message => message.id === cursor.firstId) : -1;
  const count = index < 0 ? MESSAGE_RENDER_LIMIT : Math.max(1, Math.min(MESSAGE_RENDER_MAX, cursor!.count));
  const start = index < 0 ? Math.max(0, messages.length - count) : index;
  const end = Math.min(messages.length, start + count);
  return { messages: start === 0 && end === messages.length ? messages : messages.slice(start, end),
    hiddenCount: start, newerCount: messages.length - end, start };
}

export function shiftMessageWindow(messages: ChatMessage[], current: MessageWindow, direction: 'earlier' | 'newer'): MessageWindowCursor | undefined {
  if (!messages.length) return;
  const start = direction === 'earlier'
    ? Math.max(0, current.start - MESSAGE_RENDER_STEP)
    : Math.min(Math.max(0, messages.length - MESSAGE_RENDER_MAX), current.start + MESSAGE_RENDER_STEP);
  return { firstId: messages[start].id, count: MESSAGE_RENDER_MAX };
}

/** Preserve the anchor's pixel position when rows before/after it are replaced. */
export function anchoredScrollTop(scrollTop: number, beforeTop: number, afterTop: number) {
  return Math.max(0, scrollTop + afterTop - beforeTop);
}
