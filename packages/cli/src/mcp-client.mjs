import { installationOptions } from "./installation.mjs";
import { authenticatedRequest, responsePayload } from "./api-client.mjs";
import { requireCurrentTool } from "./retired-tools.mjs";

export async function listMcpTools(store, options = {}) {
  return mcpRequest(store, "tools/list", {}, options);
}

export async function callMcpTool(store, name, args, options = {}) {
  requireCurrentTool(name);
  return mcpRequest(store, "tools/call", { name, arguments: args }, options);
}

async function mcpRequest(store, method, params, options) {
  const mcpUrl = installationOptions(options).mcpUrl;
  const response = await authenticatedRequest(store, mcpUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params
    })
  }, options);
  const rpc = await responsePayload(response);
  if (rpc.error) {
    throw new Error(rpc.error.message || "Workspace MCP request failed");
  }
  return rpc.result ?? {};
}
