import type { WorkspaceMateHostContext } from "./context.ts";
import type { WorkspaceMateEnvironmentContext } from "./environment.ts";

export type WorkspaceMateTask = {
  id: string;
  mateId: string;
  conversationId?: string;
  releaseId?: string;
  sessionId?: string;
  channel?: WorkspaceMateTaskChannel;
  createdAt?: string;
  updatedAt?: string;
  status: "queued" | "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled";
  /** Bounded directory projection; the full instruction remains on the Task. */
  title?: string;
  instruction: string;
  conclusion?: {
    actions?: unknown[];
    outcome: string;
    summary: string;
    artifacts: unknown[];
    failures?: unknown[];
    followUps: unknown[];
    pendingApprovals?: unknown[];
  };
};

export type WorkspaceMateTaskChannel = "sdk" | "web" | "email" | "schedule" | "mate_call";

export type WorkspaceMateCreateTaskOptions = {
  channel?: WorkspaceMateTaskChannel;
  conversationId?: string;
};

export type WorkspaceMateAppMcpOperation = {
  appId: string;
  arguments: Record<string, unknown>;
  toolName: string;
};

export type WorkspaceMateApproval = {
  actionDigest: string;
  expiresAt: string;
  id: string;
  operation: WorkspaceMateAppMcpOperation & { type?: "app_mcp_tool_call" };
  riskLevel: "low" | "medium" | "high" | "critical";
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  taskId: string;
};

export type WorkspaceMateExecutionResult = {
  approval?: WorkspaceMateApproval;
  output?: unknown;
  task: WorkspaceMateTask;
};

export type WorkspaceMateHostEvent =
  | { type: "task.updated"; taskId: string; status: WorkspaceMateTask["status"] }
  | { type: "approval.requested"; taskId: string; approvalId: string }
  | { type: "resource.refresh"; appId: string; resources: Array<{ type: string; id: string }> }
  | { type: "navigation.request"; appId: string; route: string };

type WorkspaceMateClientBaseOptions = {
  accessToken: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
  mode?: "live" | "preview";
  onEvent?: (event: WorkspaceMateHostEvent) => void;
  releaseId?: string;
  runtimeOrigin: string;
  mateId: string;
};

export type WorkspaceMateClientOptions = WorkspaceMateClientBaseOptions & (
  | {
      /** Mate 2.0 compatibility context. New integrations should use environment. */
      context: WorkspaceMateHostContext;
      environment?: never;
    }
  | {
      context?: never;
      environment: WorkspaceMateEnvironmentContext;
    }
);

export type WorkspaceMateMountOptions = WorkspaceMateClientOptions & {
  container: HTMLElement;
  placeholder?: string;
};
