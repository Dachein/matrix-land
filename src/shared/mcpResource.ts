/** A deployment owns one HTTPS MCP origin. Never infer another installation. */
export function configuredMcpOrigin(value: string | undefined): string | undefined {
  try {
    const url = new URL(value?.trim() || "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    if (!["/", "/mcp", "/mcp/"].includes(url.pathname)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function canonicalMcpResource(value: string | undefined, configured: string | undefined) {
  const origin = configuredMcpOrigin(configured);
  return origin && (!value || configuredMcpOrigin(value) === origin) ? origin : undefined;
}
