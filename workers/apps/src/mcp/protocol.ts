import { json } from "../core/http";

export type McpToolErrorCategory = "authorization" | "configuration" | "conflict" | "dependency" | "internal" | "validation";

export type McpToolError = {
  category: McpToolErrorCategory;
  code: string;
  details?: Record<string, unknown>;
  handoff: {
    afterSuccess?: string[];
    nextAction: {
      arguments?: Record<string, unknown>;
      kind: "contact_support" | "tool_call" | "user_action" | "wait_retry";
      reason: string;
      requiresUserApproval: boolean;
      tool?: string;
    };
    retry?: {
      requiresUserApproval: boolean;
      reuseOriginalArguments: boolean;
      tool: string;
    };
    state: "action_required" | "blocked" | "retry_available";
  };
  operation: string;
  requestId: string;
  resource?: { id: string; type: string };
  retryable: boolean;
  schemaVersion: "workspace.mcp.error.v1";
  status: number;
  summary: string;
};

export type McpCallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export function mcpTextResult(payload: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

export function mcpPlainTextResult(text: string) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

export function mcpToolErrorResult(error: McpToolError): McpCallToolResult {
  const action = error.handoff.nextAction;
  const nextStep = action.kind === "tool_call" && action.tool
    ? `Next: call ${action.tool}${action.arguments ? ` with ${JSON.stringify(action.arguments)}` : ""}.`
    : `Next: ${action.reason}`;
  const details = error.details?.security && typeof error.details.security === "object"
    ? error.details.security as Record<string, unknown>
    : undefined;
  const auth = details?.auth && typeof details.auth === "object"
    ? details.auth as Record<string, unknown>
    : undefined;
  const findings = Array.isArray(auth?.findings) ? auth.findings : [];
  const how = findings
    .map((finding) => finding && typeof finding === "object" && "how" in finding ? String((finding as { how?: unknown }).how ?? "") : "")
    .filter(Boolean)
    .join(" ");

  return {
    isError: true,
    content: [{
      type: "text",
      text: [
        `${error.operation} did not run: ${error.summary}`,
        how,
        nextStep,
        `Request ID: ${error.requestId}`
      ].filter(Boolean).join("\n")
    }],
    structuredContent: { error }
  };
}

export function jsonRpcResult(id: string | number | null, result: unknown) {
  return json({
    jsonrpc: "2.0",
    id,
    result
  });
}

export function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown) {
  return json({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      ...(data === undefined ? {} : { data }),
      message
    }
  });
}
