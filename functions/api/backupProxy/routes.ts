import type { ApiRouteHandler } from "../routeTypes.ts";

export const dispatchBackupRoutes: ApiRouteHandler = async (context, services, path) => {
  if (path === "backups" || path.startsWith("backups/")) {
    return services.backupProxyApi.proxyBackupWorkerRequest(context, path);
  }
  return undefined;
};
