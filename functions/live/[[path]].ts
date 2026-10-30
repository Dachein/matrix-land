type LiveProxyEnv = {
  LIVE_WORKER_URL?: string;
};

type PagesContext = EventContext<LiveProxyEnv, string, { path?: string | string[] }>;

const LIVE_READ_PATHS = new Set(["health", "v1/live", "v1/snapshot"]);

export const onRequest: PagesFunction<LiveProxyEnv, string, { path?: string | string[] }> = async (context) => {
  if (context.request.method !== "GET") {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  const path = normalizePathParam(context.params.path);
  if (!LIVE_READ_PATHS.has(path)) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  const source = new URL(context.request.url);
  const liveOrigin = context.env?.LIVE_WORKER_URL?.trim();
  if(!liveOrigin) return Response.json({error:"live_not_configured"},{status:503});
  const target = new URL(`${liveOrigin.replace(/\/+$/, "")}/${path}`);
  target.search = source.search;
  return fetch(new Request(target.toString(), context.request));
};

function normalizePathParam(value: string | string[] | undefined) {
  const parts = Array.isArray(value) ? value : value ? [value] : [];
  return parts
    .flatMap((part) => part.split("/"))
    .map((part) => encodeURIComponent(part))
    .join("/");
}
