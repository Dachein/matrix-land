export function safeChatError(error: unknown, depth = 0): string {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof source.code === "string" ? source.code : "";
  if (/^[a-z][a-z0-9_]{2,95}$/.test(code)) return code;
  if (error instanceof Error && /^[a-z][a-z0-9_]{2,95}$/.test(error.message)) return error.message;
  if (depth < 3 && source.cause) {
    const cause = safeChatError(source.cause, depth + 1);
    if (cause !== "mate_chat_unavailable" && cause !== "error") return cause;
  }
  const name = typeof source.name === "string"
    ? source.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()
    : "";
  return /^[a-z][a-z0-9_]{2,95}$/.test(name) ? name : "mate_chat_unavailable";
}

export function chatErrorCategory(input: { connectionError?: unknown; error?: unknown; hydrationError?: unknown }) {
  if (input.connectionError) return "connection" as const;
  if (input.hydrationError) return "history" as const;
  if (input.error) return "reply" as const;
  return undefined;
}

export function chatErrorLabel(category: "connection" | "history" | "reply", english: boolean) {
  if (category === "connection") return english ? "Connection failed. Reconnect to continue." : "连接异常，请重新连接。";
  if (category === "history") return english ? "Conversation history could not load. Please try again." : "会话记录加载失败，请重试。";
  return english ? "The response failed. You can retry or send another message." : "本次回复失败，可以重试或发送新消息。";
}

export function chatPauseLabel(reason: string | undefined, english: boolean) {
  if (reason === "tool_outcome_unknown") return english ? "An operation may have completed, but its result is unconfirmed. Check it before continuing." : "有操作可能已完成，但结果尚未确认。请先核实，再继续。";
  if (reason === "output_limit") return english ? "The response reached its length limit. Progress is saved; you can continue." : "回复达到长度上限，进度已保存，可以继续执行。";
  if (reason === "unknown_finish") return english ? "The run ended without a confirmed final result. Progress is saved; you can continue." : "本轮结束时未确认最终结果，进度已保存，可以继续执行。";
  if (reason === "no_text") return english ? "This run ended without a final response. Progress is saved; you can continue." : "本轮未生成最终回复，进度已保存，可以继续执行。";
  if (reason === "no_progress") return english ? "Repeated operations made no new progress. Review the request before continuing." : "重复操作未取得新进展，可以调整要求后继续。";
  return english ? "The task is paused. Progress is saved; you can continue." : "任务已暂停，进度已保存，可以继续执行。";
}
