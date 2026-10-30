import { configuredMcpOrigin } from "./mcpResource.ts";
import { type WorkspaceCliAgent } from "./workspaceCli.ts";

export type McpPromptLocale = "en" | "zh";
export type McpInstallAgent = WorkspaceCliAgent;

export function directMcpInstallPrompt(agent: McpInstallAgent, locale: McpPromptLocale, resourceUrl: string) {
  const label = mcpAgentLabel(agent);
  const origin = configuredMcpOrigin(resourceUrl);
  if (!origin) throw new Error("mcp_resource_not_configured");
  return locale === "zh"
    ? `为 ${label} 连接当前企业的 MCP：${origin}/mcp。使用客户端的远程 MCP（Streamable HTTP）配置，通过服务发现完成 OAuth 授权。确认授权页面属于当前企业。连接后调用 ping_who_am_i 验证账号。`
    : `Connect ${label} to this workspace at ${origin}/mcp using remote MCP (Streamable HTTP) and OAuth discovery. Verify that the approval page belongs to this workspace, then call ping_who_am_i to verify your account.`;
}

function mcpAgentLabel(agent: McpInstallAgent) {
  if (agent === "claude-code") return "Claude Code";
  if (agent === "codex") return "Codex";
  if (agent === "cursor") return "Cursor";
  return "WorkBuddy";
}
