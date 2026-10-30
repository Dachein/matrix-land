import type { McpAgentType } from "../../types.ts";

// MCP persistence limits and supported clients, agents and scopes.
export const DEFAULT_MCP_CLIENT_ID = "workspace-ai-mcp";

export const MAX_ACTIVE_MCP_CONNECTIONS = 3;

export const DEFAULT_MCP_IDLE_TTL_SECONDS = 7 * 24 * 60 * 60;

export const DEFAULT_MCP_SCOPES = [
  "workspace:mail:read",
  "workspace:mail:write", "workspace:mail:send",
  "workspace:forum:read",
  "workspace:forum:write",
  "workspace:hub:read",
  "workspace:apps:read",
  "workspace:apps:write",
  "workspace:knowledge:read",
  "workspace:knowledge:write",
  "workspace:knowledge:share"
];

export const SUPPORTED_MCP_SCOPES = [
  ...DEFAULT_MCP_SCOPES,
  "workspace:market:read"
];

export const SUPPORTED_MCP_AGENTS: McpAgentType[] = ["claude-code", "codex", "workbuddy", "cursor"];
