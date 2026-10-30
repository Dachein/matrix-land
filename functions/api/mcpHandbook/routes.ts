import { buildMcpHandbook } from "../../../src/shared/mcpHandbook.ts";
import { mcpTools } from "../../../workers/mcp/src/tools.ts";
import { json } from "../http.ts";
import type { ApiRouteHandler } from "../routeTypes.ts";

export const dispatchMcpHandbookRoutes: ApiRouteHandler = async (context, services, path) => {
  if (context.request.method !== "GET" || path !== "mcp/handbook") {
    return undefined;
  }

  await services.resolveCurrentUser(context);
  const tools = await mcpTools();
  return json(buildMcpHandbook(tools), {
    headers: {
      "Cache-Control": "private, max-age=300",
      Vary: "Cookie"
    }
  });
};
