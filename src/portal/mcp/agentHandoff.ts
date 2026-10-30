export const WORKSPACE_MCP_GUIDE_TOPIC_ID = "forum-topic-workspace-ai-mcp-guide";

export type ForumAgentHandoffTarget = {
  postId?: string;
  title: string;
  topicId: string;
  url: string;
};

export function forumAgentHandoffText(target: ForumAgentHandoffTarget, locale: "en" | "zh-CN") {
  const lines = locale === "zh-CN"
    ? [
        "请通过 Workspace MCP 接手这个 Forum Post。",
        "",
        `主题：${target.title}`,
        `Topic ID：${target.topicId}`,
        target.postId ? `目标 Post ID：${target.postId}` : "",
        `Portal URL：${target.url}`,
        "",
        `请先调用 forum_read，并传入 action=\"get_topic\"、topicId=\"${target.topicId}\"，读取我有权限访问的完整主题与回复。`,
        target.postId ? `优先处理 Post ID \"${target.postId}\" 对应的内容。` : "",
        "先向我确认你理解的任务目标；涉及发布、回复或其他写入动作时，执行前先征得我的明确同意。"
      ]
    : [
        "Take over this Forum Post through Workspace MCP.",
        "",
        `Topic: ${target.title}`,
        `Topic ID: ${target.topicId}`,
        target.postId ? `Target Post ID: ${target.postId}` : "",
        `Portal URL: ${target.url}`,
        "",
        `First call forum_read with action=\"get_topic\" and topicId=\"${target.topicId}\" to read the full topic and replies I am authorized to access.`,
        target.postId ? `Prioritize the content for Post ID \"${target.postId}\".` : "",
        "Confirm your understanding of my goal first. Ask for my explicit approval before publishing, replying, or taking any other write action."
      ];

  return lines.filter(Boolean).join("\n");
}
