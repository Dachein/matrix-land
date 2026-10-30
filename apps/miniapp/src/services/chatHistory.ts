import type { ChatMessage, ChatGrant } from "../types";

/** Load the same ordered, authoritative cursor pages as the Web chat host. */
export async function loadChatHistory(grant: ChatGrant, dependencies: {
  page: (grant: ChatGrant, cursor?: string) => Promise<{ data: unknown; headers: Record<string, unknown> }>;
  refreshGrant: () => Promise<ChatGrant>;
}): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let activeGrant = grant;
  for (;;) {
    let result;
    try { result = await dependencies.page(activeGrant, cursor); }
    catch (error) {
      const candidate = (error && typeof error === "object" ? error : {}) as { code?: string; status?: number };
      if (candidate.status !== 401 && !/^(mate_chat_grant_(invalid|expired)|http_401|auth_required)$/.test(candidate.code || "")) throw error;
      activeGrant = await dependencies.refreshGrant();
      result = await dependencies.page(activeGrant, cursor);
    }
    if (!Array.isArray(result.data)) throw new Error("mate_chat_history_invalid");
    for (const message of result.data) {
      if (!message || typeof message.id !== "string" || !["user", "assistant", "system"].includes(message.role) || !Array.isArray(message.parts) || ids.has(message.id)) throw new Error("mate_chat_history_invalid");
      ids.add(message.id);
      messages.push(message);
    }
    const next = Object.entries(result.headers).find(([name]) => name.toLowerCase() === "x-workspace-chat-next-cursor")?.[1];
    if (!next) return messages;
    if (typeof next !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(next) || cursors.has(next) || result.data.at(-1)?.id !== next) throw new Error("mate_chat_history_invalid");
    cursors.add(next);
    cursor = next;
  }
}
