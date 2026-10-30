/** Old local tool calls must not send their private arguments to the hosted MCP. */
export function requireCurrentTool(name) {
  if (typeof name === "string" && name.startsWith("yida_")) {
    throw new Error("Local YiDA tools were removed in Workspace CLI 1.5.1. Restart the MCP client to refresh its tool catalog.");
  }
}
