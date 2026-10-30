import { dispatchInstallationRoutes } from "./installation/routes.ts";
import { portalApiModule, workspaceModulesFromEnv } from "../../src/shared/workspaceModules.ts";
import { dispatchActivityRoutes } from "./activity/routes.ts";
import type { ApiServices } from "./apiServices.ts";
import { dispatchAuthRoutes } from "./authBoundary/routes.ts";
import { dispatchBackupRoutes } from "./backupProxy/routes.ts";
import { dispatchCatalogRoutes } from "./catalog/routes.ts";
import type { PagesContext } from "./env.ts";
import { dispatchForumRoutes } from "./forum/routes.ts";
import { json } from "./http.ts";
import { dispatchJourneyRoutes } from "./journey/routes.ts";
import { dispatchAppsRoutes } from "./appsProxy/routes.ts";
import { dispatchLlmGatewayRoutes } from "./llmGateway/routes.ts";
import { dispatchPublicationRoutes } from "./publication/routes.ts";
import { dispatchMcpHandbookRoutes } from "./mcpHandbook/routes.ts";
import { dispatchMcpPortalRoutes } from "./mcpPortal/routes.ts";
import { dispatchNotificationsRoutes } from "./notifications/routes.ts";
import { dispatchReadModelRoutes } from "./readModels/routes.ts";
import { dispatchMateRuntimeRoutes } from "./mateRuntime/routes.ts";
import { dispatchWorkspaceFileRoutes } from "./mateRuntime/workspaceFileRoutes.ts";
import type { ApiRouteHandler } from "./routeTypes.ts";
import { dispatchUsersRoutes } from "./users/routes.ts";

export async function dispatchApiRoute(context: PagesContext, services: ApiServices, path: string) {
  const requiredModule = portalApiModule(path);
  if (requiredModule && !workspaceModulesFromEnv(context.env).includes(requiredModule)) return json({ error: "module_not_enabled", module: requiredModule }, { status: 404 });
  const routeGroups: ApiRouteHandler[] = [
    dispatchAuthRoutes,
    dispatchInstallationRoutes,
    dispatchBackupRoutes,
    dispatchAppsRoutes,
    dispatchCatalogRoutes,
    dispatchActivityRoutes,
    dispatchJourneyRoutes,
    dispatchLlmGatewayRoutes,
    dispatchReadModelRoutes,
    dispatchUsersRoutes,
    dispatchMateRuntimeRoutes,
    dispatchWorkspaceFileRoutes,
    dispatchMcpHandbookRoutes,
    dispatchMcpPortalRoutes,
    dispatchNotificationsRoutes,
    dispatchPublicationRoutes,
    dispatchForumRoutes
  ];

  for (const routeGroup of routeGroups) {
    const response = await routeGroup(context, services, path);
    if (response) {
      return response;
    }
  }

  return json({ error: "not_found", path }, { status: 404 });
}
