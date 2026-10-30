import type { ApiRouteHandler } from "../routeTypes.ts";

export const dispatchLlmGatewayRoutes: ApiRouteHandler = async (context, services, path) => {
  if (context.request.method === "GET" && path === "llm-gateway/model-catalog") {
    return await services.llmGatewayDevProxyApi.getModelCatalog(context);
  }

  if (context.request.method === "POST" && path === "llm-gateway/chat") {
    return await services.llmGatewayDevProxyApi.runChat(context);
  }

  if (context.request.method === "GET" && path === "llm-gateway/model-health") {
    return await services.llmGatewayModelHealthApi.getAdminModelHealth(context);
  }

  if (context.request.method === "GET" && path === "llm-gateway/group-usage") {
    return await services.llmGatewayGroupUsageApi.getGroupUsage(context);
  }

  if (context.request.method === "GET" && path === "llm-gateway/access") {
    return await services.llmGatewayAccessApi.getAccess(context);
  }

  if (context.request.method === "GET" && path === "llm-gateway/access/usage/summary") {
    return await services.llmGatewayAccessApi.getUsageSummary(context);
  }

  if (context.request.method === "POST" && path === "llm-gateway/access/usage/refresh") {
    return await services.llmGatewayAccessApi.refreshAccessUsage(context);
  }

  if (context.request.method === "GET" && path === "llm-gateway/access/usage/breakdown") {
    return await services.llmGatewayAccessApi.getUsageBreakdown(context);
  }

  if (context.request.method === "POST" && path === "llm-gateway/access/tokens") {
    return await services.llmGatewayAccessApi.createAccessToken(context);
  }

  const accessTokenMatch = path.match(/^llm-gateway\/access\/tokens\/([^/]+)$/);
  if (context.request.method === "PATCH" && accessTokenMatch?.[1]) {
    return await services.llmGatewayAccessApi.updateAccessToken(context, accessTokenMatch[1]);
  }

  if (context.request.method === "DELETE" && accessTokenMatch?.[1]) {
    return await services.llmGatewayAccessApi.deleteAccessToken(context, accessTokenMatch[1]);
  }

  const revokeMatch = path.match(/^llm-gateway\/access\/tokens\/([^/]+)\/revoke$/);
  if (context.request.method === "POST" && revokeMatch?.[1]) {
    return await services.llmGatewayAccessApi.revokeAccessToken(context, revokeMatch[1]);
  }

  const testMatch = path.match(/^llm-gateway\/access\/tokens\/([^/]+)\/test$/);
  if (context.request.method === "POST" && testMatch?.[1]) {
    return await services.llmGatewayAccessApi.testAccessToken(context, decodeURIComponent(testMatch[1]));
  }

  const suspendMatch = path.match(/^llm-gateway\/access\/tokens\/([^/]+)\/suspend$/);
  if (context.request.method === "POST" && suspendMatch?.[1]) {
    return await services.llmGatewayAccessApi.suspendAccessToken(context, suspendMatch[1]);
  }

  const activateMatch = path.match(/^llm-gateway\/access\/tokens\/([^/]+)\/activate$/);
  if (context.request.method === "POST" && activateMatch?.[1]) {
    return await services.llmGatewayAccessApi.activateAccessToken(context, activateMatch[1]);
  }

  const rotateMatch = path.match(/^llm-gateway\/access\/tokens\/([^/]+)\/rotate$/);
  if (context.request.method === "POST" && rotateMatch?.[1]) {
    return await services.llmGatewayAccessApi.rotateAccessToken(context, rotateMatch[1]);
  }

  if (context.request.method === "GET" && path === "llm-gateway/admin/allocations") {
    return await services.llmGatewayAdminAllocationsApi.getAdminAllocations(context);
  }

  if (context.request.method === "POST" && path === "llm-gateway/admin/allocations/user-limits") {
    return await services.llmGatewayAdminAllocationsApi.upsertAdminUserLimit(context);
  }

  const adminTokenMatch = path.match(/^llm-gateway\/admin\/tokens\/([^/]+)$/);
  if (context.request.method === "PATCH" && adminTokenMatch?.[1]) {
    return await services.llmGatewayAdminAllocationsApi.updateAdminToken(context, decodeURIComponent(adminTokenMatch[1]));
  }

  if (context.request.method === "DELETE" && adminTokenMatch?.[1]) {
    return await services.llmGatewayAdminAllocationsApi.deleteAdminToken(context, decodeURIComponent(adminTokenMatch[1]));
  }

  const adminTokenSuspendMatch = path.match(/^llm-gateway\/admin\/tokens\/([^/]+)\/suspend$/);
  if (context.request.method === "POST" && adminTokenSuspendMatch?.[1]) {
    return await services.llmGatewayAdminAllocationsApi.suspendAdminToken(context, decodeURIComponent(adminTokenSuspendMatch[1]));
  }

  const adminTokenActivateMatch = path.match(/^llm-gateway\/admin\/tokens\/([^/]+)\/activate$/);
  if (context.request.method === "POST" && adminTokenActivateMatch?.[1]) {
    return await services.llmGatewayAdminAllocationsApi.activateAdminToken(context, decodeURIComponent(adminTokenActivateMatch[1]));
  }

  if (context.request.method === "GET" && path === "llm-gateway/admin/usage") {
    return await services.llmGatewayAdminUsageApi.getAdminUsage(context);
  }

  if (context.request.method === "POST" && path === "llm-gateway/admin/usage/export-link") {
    return await services.llmGatewayAdminUsageApi.createUsageExportLink(context);
  }

  if (context.request.method === "GET" && path === "llm-gateway/admin/usage/export") {
    return await services.llmGatewayAdminUsageApi.downloadUsageExport(context);
  }

  return undefined;
};
