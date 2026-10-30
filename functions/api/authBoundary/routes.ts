import { json } from "../http.ts";
import type { ApiRouteHandler } from "../routeTypes.ts";

export const dispatchAuthRoutes: ApiRouteHandler = async (context, services, path) => {
  if (context.request.method === "GET" && path === "auth/session") {
    return json(await services.readAuthSession(context));
  }

  if (context.request.method === "GET" && path === "auth/login") {
    return services.redirectToAuthPath(context.request, "/auth/login");
  }

  if (context.request.method === "GET" && path === "auth/callback") {
    return services.redirectToAuthPath(context.request, "/auth/callback");
  }

  if (context.request.method === "GET" && path === "auth/logout") {
    return services.redirectToAuthPath(context.request, "/auth/logout");
  }

  if (context.request.method === "GET" && path === "auth/current-user") {
    return json({ user: await services.resolveCurrentUser(context) });
  }

  if (context.request.method === "POST" && path === "auth/direct-jump") {
    return json(await services.authBoundaryApi.createDirectJumpToken(context));
  }

  if (context.request.method === "POST" && path === "auth/verify-direct-jump") {
    return json(await services.authBoundaryApi.verifyDirectJumpToken(context));
  }

  if (context.request.method === "POST" && path === "api-keys") {
    return json(await services.authBoundaryApi.issueApiKey(context));
  }

  if (context.request.method === "POST" && path === "audit") {
    return json(await services.authBoundaryApi.writeAuditEvent(context));
  }

  return undefined;
};
