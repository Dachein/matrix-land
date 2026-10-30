import { json } from "../http.ts";
import type { ApiRouteHandler } from "../routeTypes.ts";

export const dispatchReadModelRoutes: ApiRouteHandler = async (context, services, path) => {
  const appMatch = path.match(/^apps\/([^/]+)$/);
  if (context.request.method === "GET" && appMatch) {
    return json(await services.readModelsApi.getApp(context, decodeURIComponent(appMatch[1])));
  }

  if (context.request.method === "GET" && path === "apps") {
    return json(await services.readModelsApi.listApps(context));
  }

  if (context.request.method === "GET" && path === "categories") {
    return json(await services.readModelsApi.listCategories(context));
  }

  if (context.request.method === "GET" && path === "skills") {
    return json(await services.readModelsApi.listSkills(context));
  }

  if (context.request.method === "GET" && path === "data-services") {
    return json(await services.readModelsApi.listDataServices(context));
  }

  if (context.request.method === "GET" && path === "usage/me") {
    return json(await services.readModelsApi.readUsage(context));
  }

  if (context.request.method === "GET" && path === "mcp/tools") {
    return json(await services.readModelsApi.listMcpTools(context));
  }

  if (context.request.method === "GET" && path === "admin/audit") {
    return json(await services.readModelsApi.listAdminAudit(context));
  }

  if (context.request.method === "GET" && path === "admin/review-queue") {
    return json(await services.readModelsApi.listAdminReviewQueue(context));
  }

  return undefined;
};
