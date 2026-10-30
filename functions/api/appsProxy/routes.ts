import { json } from "../http.ts";
import type { ApiRouteHandler } from "../routeTypes.ts";

export const dispatchAppsRoutes: ApiRouteHandler = async (context, services, path) => {
  if (context.request.method === "POST" && path === "apps/token") {
    return json(await services.appsTokenApi.issueAppsToken(context));
  }

  if (context.request.method === "POST" && path === "mcp/token") {
    return json(await services.appsTokenApi.issueAppsToken(context));
  }

  if (context.request.method === "GET" && (path === "apps" || /^apps\/[^/]+$/.test(path) && !["apps/apps","apps/skills","apps/resources","apps/mates"].includes(path))) return undefined;
  if (path === "apps" || path.startsWith("apps/")) {
    return await services.appsProxyApi.proxyAppsWorkerRequest(context, path);
  }

  return undefined;
};
