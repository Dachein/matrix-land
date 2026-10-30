import type { ApiRouteHandler } from "../routeTypes.ts";

export const dispatchMcpPortalRoutes: ApiRouteHandler = async (context, services, path) => {
  if (context.request.method === "GET" && path === "admin/login-email-policy") {
    return await services.mcpPortalApi.readAdminLoginEmailPolicy(context);
  }

  if (context.request.method === "POST" && path === "admin/login-email-policy") {
    return await services.mcpPortalApi.updateAdminLoginEmailPolicy(context);
  }

  if (context.request.method === "GET" && path === "admin/mcp/connections") {
    return await services.mcpPortalApi.readAdminConnections(context);
  }

  const adminConnectionDisableMatch = path.match(/^admin\/mcp\/connections\/([^/]+)\/disable$/);
  if (context.request.method === "POST" && adminConnectionDisableMatch?.[1]) {
    return await services.mcpPortalApi.disableAdminConnection(context, adminConnectionDisableMatch[1]);
  }

  if (context.request.method === "GET" && path === "mcp/connections/status") {
    return await services.mcpPortalApi.readConnectionStatus(context);
  }

  const connectionMatch = path.match(/^mcp\/connections\/([^/]+)$/);
  if (context.request.method === "DELETE" && connectionMatch?.[1]) {
    return await services.mcpPortalApi.revokeConnection(context, connectionMatch[1]);
  }

  if (context.request.method === "GET" && path === "mcp/install/config") {
    return await services.mcpPortalApi.readInstallConfig(context);
  }

  return undefined;
};
