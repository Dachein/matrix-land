type SearchItem = {
  description?: string;
  lastModifiedDate?: string;
  title: string;
  url: string;
};

// The deployed AI binding supports websearch before the pinned Workers types do.
type SearchAiBinding = {
  websearch(input: { gatewayId: string; provider: "exa"; query: string; limit: number }): Promise<Response>;
};

export class CloudflareWebSearchError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function searchCloudflareExa(ai: Ai | undefined, query: string, limit: number) {
  const binding = ai as unknown as SearchAiBinding | undefined;
  if (!binding || typeof binding.websearch !== "function") {
    throw new CloudflareWebSearchError(503, "cloudflare_web_search_not_configured");
  }
  const response = await binding.websearch({
    gatewayId: "default", provider: "exa", query, limit
  });
  if (!response.ok) throw new CloudflareWebSearchError(502, "cloudflare_web_search_upstream_failed");
  const body = await response.json() as { items?: SearchItem[]; metadata?: { query?: string; requestId?: string } };
  if (!Array.isArray(body?.items) || body.items.some((item) =>
    !item || typeof item.title !== "string" || typeof item.url !== "string"
  )) throw new CloudflareWebSearchError(502, "cloudflare_web_search_invalid_result");
  return {
    provider: "cloudflare_web_search",
    searchProvider: "exa",
    query: body.metadata?.query || query,
    requestId: body.metadata?.requestId ?? null,
    count: body.items.slice(0, limit).length,
    results: body.items.slice(0, limit).map((item) => ({
      title: item.title, url: item.url, description: item.description,
      lastModifiedDate: item.lastModifiedDate
    }))
  };
}
