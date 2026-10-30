import type { ChatMessage, Conversation, LiveSession, Mate, User } from "../types";

export const mockUser: User = { id: "user_demo", name: "陈默", email: "mo.chen@example.invalid" };
export const mockMates: Mate[] = [
  { id: "cortana", displayName: "Cortana", jobRole: "私人银行工作伙伴", description: "帮助你整理研究、准备客户会议并推进日常工作。", status: "在线" },
  { id: "portfolio-banker", displayName: "Portfolio Banker", jobRole: "投资组合顾问", description: "围绕持仓、市场与客户目标提供分析支持。", status: "在线" },
  { id: "knowledge-access", displayName: "Knowledge", jobRole: "知识研究助手", description: "检索内部知识并给出带来源的答案。", status: "在线" }
];
export const mockConversations: Conversation[] = [
  { id: "conv_morning", title: "今日市场晨会准备", updatedAt: new Date(Date.now() - 12 * 60_000).toISOString(), pinned: true },
  { id: "conv_client", title: "李先生组合回顾", updatedAt: new Date(Date.now() - 86 * 60_000).toISOString() },
  { id: "conv_research", title: "AI 基建行业研究", updatedAt: new Date(Date.now() - 26 * 60 * 60_000).toISOString() }
];
export const mockMessages: ChatMessage[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "帮我准备今天的客户沟通要点。" }] },
  { id: "m2", role: "assistant", parts: [{ type: "text", text: "可以。我会先结合最近的市场变化和客户组合，整理成一页简明提纲。你希望更侧重收益复盘，还是下一阶段配置建议？" }] }
];

export function mockSession(mate: Mate, conversationId?: string): LiveSession {
  return {
    accessToken: "mock_access_token",
    conversationId: conversationId || `conv_${Date.now()}`,
    conversationState: conversationId ? "persisted" : "draft",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    principalKey: "mock_principal",
    mate
  };
}
