export function mcpToolPayload(result) {
  if (result?.isError) {
    const code = result.structuredContent?.error?.code;
    const text = result.content?.map((item) => item?.text).filter(Boolean).join("\n");
    throw new Error(code || text || "Workspace MCP tool failed");
  }
  const text = result?.content?.find((item) => item?.type === "text" && typeof item.text === "string")?.text;
  if (!text) return result ?? {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}
