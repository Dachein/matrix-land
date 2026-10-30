export function jsonRpcError(id: string | number | null, code: number, message: string, data?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {})
    }
  };
}

export function jsonRpcResult(id: string | number | null, result: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

export function mcpTextResult(value: unknown) {
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

export type McpCallToolResult = {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export function isMcpCallToolResult(value: unknown): value is McpCallToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Array.isArray((value as { content?: unknown }).content);
}

export function mcpToolErrorResult(input: {
  code: string;
  message?: string;
  operation: string;
  requestId: string;
  status: number;
}): McpCallToolResult {
  const category = input.status === 401 || input.status === 403
    ? "authorization"
    : input.status === 409
      ? "conflict"
      : input.status >= 500
        ? "internal"
        : "validation";
  const retryable = input.status === 429 || input.status >= 500;
  const reason = retryable
    ? "Retry after a short delay; use the requestId if the failure persists."
    : category === "authorization"
      ? "Ask the user or an administrator to grant the required access."
      : category === "conflict"
        ? "Resolve the required confirmation or conflicting state before retrying."
        : "Correct the tool arguments and retry the operation.";
  const error = {
    schemaVersion: "workspace.mcp.error.v1",
    code: input.code,
    category,
    status: input.status,
    retryable,
    operation: input.operation,
    requestId: input.requestId,
    summary: input.message && input.message !== input.code ? input.message : input.code,
    handoff: {
      state: retryable ? "retry_available" : "blocked",
      nextAction: {
        kind: retryable ? "wait_retry" : "user_action",
        reason,
        requiresUserApproval: true
      }
    }
  };
  return {
    isError: true,
    content: [{
      type: "text",
      text: [
        `${input.operation} did not run: ${error.summary}`,
        `Next: ${reason}`,
        `Request ID: ${input.requestId}`
      ].join("\n")
    }],
    structuredContent: { error }
  };
}
