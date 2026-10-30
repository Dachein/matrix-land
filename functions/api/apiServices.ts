import { createActivityServices } from "./activity/api.ts";
import { createAuthBoundaryServices } from "./authBoundary/api.ts";
import { createBackupServices } from "./backupProxy/api.ts";
import { createCatalogServices } from "./catalog/api.ts";
import { createForumServices } from "./forum/api.ts";
import { createJourneyServices } from "./journey/api.ts";
import { createAppsServices } from "./appsProxy/api.ts";
import { createLlmGatewayServices } from "./llmGateway/api.ts";
import { createPublicationServices } from "./publication/api.ts";
import { createMcpPortalServices } from "./mcpPortal/api.ts";
import { createNotificationsServices } from "./notifications/api.ts";
import { createReadModelServices } from "./readModels/api.ts";
import { createMateRuntimeServices } from "./mateRuntime/api.ts";
import { createUsersServices } from "./users/api.ts";

export const apiServices = {
  ...createActivityServices(),
  ...createAuthBoundaryServices(),
  ...createBackupServices(),
  ...createCatalogServices(),
  ...createForumServices(),
  ...createJourneyServices(),
  ...createAppsServices(),
  ...createLlmGatewayServices(),
  ...createPublicationServices(),
  ...createMcpPortalServices(),
  ...createNotificationsServices(),
  ...createReadModelServices(),
  ...createMateRuntimeServices(),
  ...createUsersServices()
};

export type ApiServices = typeof apiServices;
