import { installationOptions } from "./installation.mjs";
import { createInterface } from "node:readline";
import { CLI_VERSION } from "./constants.mjs";
import { currentCredential, refreshCurrentCredential } from "./auth.mjs";
import { requireCurrentTool } from "./retired-tools.mjs";

export async function runMcpProxy(store, options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const fetchImpl = options.fetchImpl ?? fetch;
  const mcpUrl = installationOptions(options).mcpUrl;
  let sessionId;
  let queue = Promise.resolve();
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    queue = queue.then(async () => {
      let message;
      try { message = JSON.parse(line); }
      catch { return; }
      try {
        if (message.method === "tools/call") requireCurrentTool(message.params?.name);
        const responses = await forward(message, false);
        for (const response of responses) {
          output.write(`${JSON.stringify(response)}\n`);
        }
      } catch (error) {
        if (message.id !== undefined) output.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: error instanceof Error ? error.message : "Workspace MCP proxy failed" } })}\n`);
      }
    });
  }
  await queue;

  async function forward(message, didRefresh) {
    let credential = await currentCredential(store, { ...options, fetchImpl });
    if (!credential) throw new Error("Workspace CLI is not authenticated");
    const headers = {
      "Accept": "application/json, text/event-stream",
      "Authorization": `Bearer ${credential.access_token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
      "User-Agent": `workspace-cli/${CLI_VERSION}`
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const response = await fetchImpl(mcpUrl, { redirect: "error", method: "POST", headers, body: JSON.stringify(message) });
    if (response.status === 401 && !didRefresh) {
      credential = await refreshCurrentCredential(store, credential, { ...options, fetchImpl });
      if (!credential) throw new Error("Workspace CLI is not authenticated");
      return forward(message, true);
    }
    if (!response.ok && response.status !== 202) throw new Error(`Workspace MCP returned HTTP ${response.status}`);
    sessionId = response.headers.get("mcp-session-id") || sessionId;
    if (response.status === 202 || !response.body) return [];
    const text = await response.text();
    if (!text.trim()) return [];
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      return text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).map(JSON.parse);
    }
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
}
