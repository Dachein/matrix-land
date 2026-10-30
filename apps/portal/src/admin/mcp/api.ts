import type {
  AdminMcpConnectionData,
  AdminMcpConnectionStatusFilter
} from "./types";

type Fetcher = typeof fetch;

export async function loadAdminMcpConnections({
  fetcher = fetch,
  query,
  signal,
  status = "active"
}: {
  fetcher?: Fetcher;
  query?: string;
  signal?: AbortSignal;
  status?: AdminMcpConnectionStatusFilter;
}): Promise<AdminMcpConnectionData> {
  const search = new URLSearchParams({ status });
  const normalizedQuery = query?.trim();
  if (normalizedQuery) {
    search.set("q", normalizedQuery);
  }

  return requestJson(fetcher, `/api/admin/mcp/connections?${search.toString()}`, { signal });
}

export async function disableAdminMcpConnection(
  connectionId: string,
  fetcher: Fetcher = fetch
) {
  return requestJson(fetcher, `/api/admin/mcp/connections/${encodeURIComponent(connectionId)}/disable`, {
    method: "POST"
  });
}

async function requestJson<T = unknown>(fetcher: Fetcher, input: string, init?: RequestInit): Promise<T> {
  const response = await fetcher(input, init);
  const payload = await response.json().catch(() => undefined) as T | { error?: string } | undefined;

  if (!response.ok || payload === undefined) {
    const errorCode = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new Error(errorCode || `admin_mcp_request_failed_${response.status}`);
  }

  return payload as T;
}
