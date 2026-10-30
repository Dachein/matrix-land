type Env = {
  MINIAPP_API_WORKER_URL?: string;
};

export const onRequest: PagesFunction<Env> = async (context) => {
  const upstream = configuredUpstream(context.env.MINIAPP_API_WORKER_URL);
  if (!upstream) {
    return Response.json({ error: "miniapp_api_worker_not_configured" }, { status: 503 });
  }

  const incoming = new URL(context.request.url);
  if (!incoming.pathname.startsWith("/api/miniapp/v1/")) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const target = new URL(`${incoming.pathname}${incoming.search}`, `${upstream}/`);
  const headers = new Headers(context.request.headers);
  headers.set("x-workspace-miniapp-public-origin", incoming.origin);
  return fetch(new Request(target, {
    body: requestBody(context.request),
    headers,
    method: context.request.method,
    redirect: "manual"
  }));
};

function configuredUpstream(value: string | undefined) {
  try {
    const url = new URL(value?.trim() || "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function requestBody(request: Request) {
  return request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
}
