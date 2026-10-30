interface Env {
  ASSETS: Fetcher;
}

export const onRequest: PagesFunction<Env> = ({ env, request }) => serveMcpHandbookPage(request, env);

export async function serveMcpHandbookPage(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      headers: { Allow: "GET, HEAD" },
      status: 405
    });
  }

  if (path !== "/workspace-pass-mcp/handbook") {
    return new Response("Not found", { status: 404 });
  }

  // Pages Clean URLs redirects /index.html to /. Fetching the root asset through
  // ASSETS serves the SPA shell directly without re-entering this Function.
  const assetUrl = new URL("/", url.origin);
  return env.ASSETS.fetch(new Request(assetUrl, request));
}
