export class McpConnectionApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "McpConnectionApiError";
    this.status = status;
  }
}

export type McpConnectionRevokeErrorKey =
  | "mcp.revokeFailed"
  | "mcp.revokeSessionRejected"
  | "mcp.revokeSignInRequired";

export async function revokeMcpConnection(connectionId: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(`/api/mcp/connections/${encodeURIComponent(connectionId)}`, {
    method: "DELETE"
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw new McpConnectionApiError(response.status, readMcpConnectionError(responseText));
  }
}

export function classifyMcpConnectionRevokeError(error: unknown): McpConnectionRevokeErrorKey {
  const status = error instanceof McpConnectionApiError ? error.status : 0;
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (status === 403) {
    return "mcp.revokeSessionRejected";
  }

  if (status === 401 || message.includes("not_authenticated")) {
    return "mcp.revokeSignInRequired";
  }

  return "mcp.revokeFailed";
}

function readMcpConnectionError(value: string) {
  if (value) {
    try {
      const payload = JSON.parse(value) as Record<string, unknown>;
      for (const key of ["error", "message"]) {
        if (typeof payload[key] === "string" && payload[key]) {
          return payload[key];
        }
      }
    } catch {
      // Fall through to the response text so operators still get a useful signal.
    }
  }

  return value || "mcp_connection_revoke_failed";
}
