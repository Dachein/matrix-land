import type { ChatMessage } from "../types";

export function messageExecution(message?: ChatMessage): { state: "paused" | "completed"; reason?: string } | undefined {
  for (const part of message?.parts || []) {
    if (part.type !== "data-mate-turn" || !part.data || typeof part.data !== "object") continue;
    const execution = (part.data as { execution?: { state?: string; reason?: string } }).execution;
    if (execution?.state === "paused" || execution?.state === "completed") return { state: execution.state, reason: execution.reason };
  }
}

export function resumableMessage(messages: ChatMessage[]) {
  const last = messages.at(-1);
  return last?.role === "assistant" && messageExecution(last)?.state === "paused" ? last : undefined;
}
