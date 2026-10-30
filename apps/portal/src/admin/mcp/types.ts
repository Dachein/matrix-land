export type AdminMcpConnectionStatus = "active" | "inactive";
export type AdminMcpConnectionStatusFilter = AdminMcpConnectionStatus | "all";

export type AdminMcpConnection = {
  agentType: "claude-code" | "codex" | "cursor" | "workbuddy";
  clientId: string;
  createdAt: string;
  displayName?: string;
  id: string;
  lastActiveAt: string;
  resourceUrl?: string;
  scopes: string[];
  status: AdminMcpConnectionStatus;
  updatedAt: string;
  user: {
    department?: string;
    email?: string;
    id: string;
    name?: string;
    team?: string;
  };
};

export type AdminMcpConnectionSummary = {
  activeCount: number;
  inactiveCount: number;
  totalCount: number;
  userCount: number;
};

export type AdminMcpConnectionData = {
  connections: AdminMcpConnection[];
  summary: AdminMcpConnectionSummary;
};
