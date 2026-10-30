import type { Env } from "../env.ts";
import { HttpError, requireDb } from "../http.ts";
import { requireAdminPortalUser, resolveCurrentUser } from "../identity/index.ts";
import { catalogCoverColumns, userProfileColumns } from "../catalog/service.ts";
import {
  readApps,
  readCurrentApp,
  readAuditEvents,
  readCategories,
  readDataServices,
  readMcpTools,
  readReviewQueue,
  readSkills,
  readUsageSummary
} from "../catalog/readModels.ts";

type ReadModelContext = EventContext<Env, string, unknown>;

export function createReadModelServices() {
  return {
    readModelsApi: {
      async getApp(context: ReadModelContext, appId: string) {
        const db = requireDb(context.env.DB);
        await resolveCurrentUser(context);
        const app = await readCurrentApp(
          db,
          await userProfileColumns(db),
          await catalogCoverColumns(db),
          appId
        );
        if (!app) {
          throw new HttpError(404, "app_not_found");
        }
        return { app };
      },

      async listApps(context: ReadModelContext) {
        const db = requireDb(context.env.DB);
        await resolveCurrentUser(context);
        const targetIds = readTargetIds(context.request);
        return { apps: await readApps(db, await userProfileColumns(db), await catalogCoverColumns(db), targetIds) };
      },

      async listCategories(context: ReadModelContext) {
        const db = requireDb(context.env.DB);
        await resolveCurrentUser(context);
        return { categories: await readCategories(db) };
      },

      async listSkills(context: ReadModelContext) {
        const db = requireDb(context.env.DB);
        await resolveCurrentUser(context);
        return { skills: await readSkills(db, await catalogCoverColumns(db)) };
      },

      async listDataServices(context: ReadModelContext) {
        const db = requireDb(context.env.DB);
        await resolveCurrentUser(context);
        return { dataServices: await readDataServices(db) };
      },

      async readUsage(context: ReadModelContext) {
        const db = requireDb(context.env.DB);
        const currentUser = await resolveCurrentUser(context);
        return { usage: await readUsageSummary(db, currentUser) };
      },

      async listMcpTools(context: ReadModelContext) {
        const db = requireDb(context.env.DB);
        await resolveCurrentUser(context);
        return { mcpTools: await readMcpTools(db) };
      },

      async listAdminAudit(context: ReadModelContext) {
        const db = requireDb(context.env.DB);
        await requireAdminPortalUser(context);
        return { audit: await readAuditEvents(db) };
      },

      async listAdminReviewQueue(context: ReadModelContext) {
        const db = requireDb(context.env.DB);
        await requireAdminPortalUser(context);
        return { reviewQueue: await readReviewQueue(db) };
      }
    }
  };
}

function readTargetIds(request: Request) {
  const url = new URL(request.url);
  return Array.from(new Set(url.searchParams.getAll("ids")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)))
    .slice(0, 24);
}
