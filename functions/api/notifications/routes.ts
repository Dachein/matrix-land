import { json } from "../http.ts";
import type { ApiRouteHandler } from "../routeTypes.ts";

export const dispatchNotificationsRoutes: ApiRouteHandler = async (context, services, path) => {
  if (context.request.method === "GET" && path === "notifications") {
    return json(await services.notificationsApi.listNotifications(context));
  }

  if (context.request.method === "POST" && path === "notifications/read") {
    return json(await services.notificationsApi.markNotificationsRead(context));
  }

  const notificationReadMatch = path.match(/^notifications\/([^/]+)\/read$/);
  if (context.request.method === "POST" && notificationReadMatch?.[1]) {
    return json(await services.notificationsApi.markNotificationsRead(context, decodeURIComponent(notificationReadMatch[1])));
  }

  return undefined;
};
