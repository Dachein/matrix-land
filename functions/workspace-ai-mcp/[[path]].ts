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

  if (path !== "/workspace-ai-mcp/handbook") {
    return new Response("Not found", { status: 404 });
  }

  return Response.redirect(new URL("/workspace-pass-mcp/handbook", url.origin), 308);
}
