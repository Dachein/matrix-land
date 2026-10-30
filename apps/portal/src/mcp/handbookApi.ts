import type { McpHandbookPayload } from "../../../../src/shared/mcpHandbook";

export async function loadMcpHandbook(fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl("/api/mcp/handbook", {
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`mcp_handbook_load_failed:${response.status}`);
  }

  return response.json() as Promise<McpHandbookPayload>;
}
