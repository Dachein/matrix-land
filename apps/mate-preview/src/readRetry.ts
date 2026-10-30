const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Retry reads only: an ambiguous write must never be executed twice. */
export async function fetchReadWithRetry(
  fetcher: typeof fetch,
  url: string | URL,
  init: RequestInit = {},
  wait: (milliseconds: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<Response> {
  if (init.method && init.method.toUpperCase() !== "GET") throw new Error("read_retry_requires_get");
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted();
    try {
      const response = await fetcher(url, { ...init, method: "GET" });
      if (!TRANSIENT_STATUSES.has(response.status) || attempt === 2) return response;
      await response.body?.cancel();
    } catch (error) {
      if (init.signal?.aborted || (error instanceof Error && error.name === "AbortError") || attempt === 2) throw error;
    }
    await wait(250 * (attempt + 1));
  }
}
