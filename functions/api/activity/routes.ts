import { json } from "../http.ts";
import type { ApiRouteHandler } from "../routeTypes.ts";

export const dispatchActivityRoutes: ApiRouteHandler = async (context, services, path) => {
  if (context.request.method === "GET" && path === "activity/events") {
    return json(await services.activityApi.listActivityEvents(context));
  }

  if (context.request.method === "POST" && path === "community/join") {
    return json(await services.activityApi.joinCommunity(context), { status: 201 });
  }

  if (context.request.method === "POST" && path === "activity/agent-events") {
    return json(await services.activityApi.publishAgentActivityEvent(context), { status: 201 });
  }

  return undefined;
};
