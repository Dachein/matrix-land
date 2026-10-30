import { normalizeWorkspaceMateHostContext, type WorkspaceMateHostContext } from "./context.ts";
import { type WorkspaceMateEnvironmentContext } from "./environment.ts";
import { WorkspaceMateEnvironmentController, type WorkspaceMateEnvironmentSnapshot } from "./environmentController.ts";
import type {
  WorkspaceMateAppMcpOperation,
  WorkspaceMateClientOptions,
  WorkspaceMateCreateTaskOptions,
  WorkspaceMateExecutionResult,
  WorkspaceMateTask,
  WorkspaceMateTaskChannel
} from "./types.ts";

export class WorkspaceMateClient {
  readonly mateId: string;
  private readonly accessToken: WorkspaceMateClientOptions["accessToken"];
  private context?: WorkspaceMateHostContext;
  readonly environment: WorkspaceMateEnvironmentController;
  private readonly fetchImpl: typeof fetch;
  private readonly mode: "live" | "preview";
  private readonly onEvent?: WorkspaceMateClientOptions["onEvent"];
  private readonly releaseId?: string;
  private readonly runtimeOrigin: string;

  constructor(options: WorkspaceMateClientOptions) {
    this.mateId = requireIdentifier(options.mateId, "mate_id_invalid");
    this.runtimeOrigin = requireOrigin(options.runtimeOrigin);
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.mode = options.mode ?? "live";
    this.onEvent = options.onEvent;
    this.releaseId = options.releaseId
      ? requireIdentifier(options.releaseId, "release_id_invalid")
      : undefined;
    if (this.mode === "preview" && !this.releaseId) {
      throw new WorkspaceMateSdkError("preview_release_id_required", 400);
    }
    if (this.mode === "live" && this.releaseId) {
      throw new WorkspaceMateSdkError("live_release_id_forbidden", 400);
    }
    if (!options.context && !options.environment) throw new WorkspaceMateSdkError("mate_context_or_environment_required", 400);
    if (options.context && options.environment) throw new WorkspaceMateSdkError("mate_context_and_environment_conflict", 400);
    this.context = options.context ? normalizeWorkspaceMateHostContext(options.context) : undefined;
    this.environment = new WorkspaceMateEnvironmentController(options.environment);
    this.environment.onChange((environment) => {
      if (environment) this.context = undefined;
    });
  }

  updateContext(context: WorkspaceMateHostContext) {
    if (this.environment.current()) throw new WorkspaceMateSdkError("mate_context_and_environment_conflict", 400);
    this.context = normalizeWorkspaceMateHostContext(context);
  }

  currentContext() {
    if (!this.context) throw new WorkspaceMateSdkError("mate_legacy_context_unavailable", 409);
    return structuredClone(this.context);
  }

  replaceEnvironment(environment: WorkspaceMateEnvironmentSnapshot) {
    return this.environment.replace(environment);
  }

  currentEnvironment(): WorkspaceMateEnvironmentContext | undefined {
    return this.environment.current();
  }

  async createTask(
    instruction: string,
    conversationOrOptions?: string | WorkspaceMateCreateTaskOptions
  ) {
    const context = this.environment.current() ?? this.context;
    if (!context) throw new WorkspaceMateSdkError("mate_context_or_environment_required", 400);
    const options = typeof conversationOrOptions === "string"
      ? { conversationId: conversationOrOptions }
      : conversationOrOptions ?? {};
    const channel = requireTaskChannel(options.channel ?? "sdk");
    if (this.mode === "preview" && options.conversationId) {
      throw new WorkspaceMateSdkError("preview_conversation_not_supported", 409);
    }
    const task = await this.request<{ task: WorkspaceMateTask }>("/tasks", {
      body: JSON.stringify({
        channel,
        context,
        instruction: requireInstruction(instruction),
        ...(options.conversationId
          ? { conversationId: requireIdentifier(options.conversationId, "conversation_id_invalid") }
          : {})
      }),
      method: "POST"
    });
    this.emitTask(task.task);
    return task.task;
  }

  async runTask(taskId: string) {
    const result = await this.request<{ task: WorkspaceMateTask }>(`/tasks/${encodeURIComponent(requireIdentifier(taskId, "task_id_invalid"))}/run`, { method: "POST" });
    this.emitTask(result.task);
    return result.task;
  }

  async runAppMcpTask(taskId: string, operation: WorkspaceMateAppMcpOperation) {
    assertNoAuthorityFields(operation);
    const result = await this.request<WorkspaceMateExecutionResult>(`/tasks/${encodeURIComponent(requireIdentifier(taskId, "task_id_invalid"))}/run`, {
      body: JSON.stringify({
        operation: {
          appId: requireIdentifier(operation.appId, "app_id_invalid"),
          arguments: operation.arguments,
          toolName: requireToolName(operation.toolName)
        }
      }),
      method: "POST"
    });
    this.emitExecution(result);
    return result;
  }

  async decideApproval(approvalId: string, decision: "approve" | "deny") {
    const result = await this.request<WorkspaceMateExecutionResult>(`/approvals/${encodeURIComponent(requireIdentifier(approvalId, "approval_id_invalid"))}/decision`, {
      body: JSON.stringify({ decision }),
      method: "POST"
    });
    this.emitExecution(result);
    return result;
  }

  async ask(
    instruction: string,
    conversationOrOptions?: string | WorkspaceMateCreateTaskOptions
  ) {
    const task = await this.createTask(instruction, conversationOrOptions);
    return this.runTask(task.id);
  }

  async listTasks(conversationId?: string) {
    const query = conversationId ? `?conversationId=${encodeURIComponent(requireIdentifier(conversationId, "conversation_id_invalid"))}` : "";
    return (await this.request<{ tasks: WorkspaceMateTask[] }>(`/tasks${query}`)).tasks;
  }

  private async request<T>(path: string, init: RequestInit = {}) {
    const token = typeof this.accessToken === "function" ? await this.accessToken() : this.accessToken;
    if (!token?.trim()) throw new WorkspaceMateSdkError("mate_access_token_missing", 401);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${token.trim()}`);
    if (init.body) headers.set("content-type", "application/json");
    const prefix = this.mode === "preview" ? "/v1/owner-test/mates" : "/v1/mates";
    const releaseQuery = this.mode === "preview"
      ? `${path.includes("?") ? "&" : "?"}release=${encodeURIComponent(this.releaseId ?? "")}`
      : "";
    const response = await this.fetchImpl(`${this.runtimeOrigin}${prefix}/${encodeURIComponent(this.mateId)}${path}${releaseQuery}`, { ...init, headers });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new WorkspaceMateSdkError(typeof payload.error === "string" ? payload.error : "mate_request_failed", response.status, payload);
    return payload as T;
  }

  private emitTask(task: WorkspaceMateTask) {
    this.onEvent?.({ type: "task.updated", taskId: task.id, status: task.status });
  }

  private emitExecution(result: WorkspaceMateExecutionResult) {
    this.emitTask(result.task);
    if (result.approval?.status === "pending") {
      this.onEvent?.({ type: "approval.requested", taskId: result.task.id, approvalId: result.approval.id });
    }
  }
}

export class WorkspaceMateSdkError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly status: number;

  constructor(code: string, status: number, details?: Record<string, unknown>) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createWorkspaceMateClient(options: WorkspaceMateClientOptions) {
  return new WorkspaceMateClient(options);
}

function requireInstruction(value: string) {
  const output = value.trim();
  if (!output) throw new WorkspaceMateSdkError("task_instruction_required", 400);
  return output.slice(0, 12_000);
}
function requireIdentifier(value: string, code: string) {
  const output = value.trim();
  if (!/^[A-Za-z0-9_-]{3,180}$/.test(output)) throw new WorkspaceMateSdkError(code, 400);
  return output;
}
function requireOrigin(value: string) {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error();
    return url.origin;
  } catch { throw new WorkspaceMateSdkError("runtime_origin_invalid", 400); }
}

function requireToolName(value: string) {
  const output = value.trim();
  if (!/^[a-z][a-z0-9_]{1,95}$/.test(output)) throw new WorkspaceMateSdkError("tool_name_invalid", 400);
  return output;
}

function requireTaskChannel(value: string): WorkspaceMateTaskChannel {
  if (value === "sdk" || value === "web" || value === "email" || value === "schedule" || value === "mate_call") {
    return value;
  }
  throw new WorkspaceMateSdkError("task_channel_invalid", 400);
}

function assertNoAuthorityFields(value: unknown) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) return value.forEach(assertNoAuthorityFields);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(userId|ownerUserId|orgId|scopes?|accessToken|refreshToken|authorization|cookie)$/i.test(key)) {
      throw new WorkspaceMateSdkError("caller_authority_field_forbidden", 400, { field: key });
    }
    assertNoAuthorityFields(child);
  }
}
