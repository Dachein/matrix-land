import { workspaceModulesFromEnv } from "../../../src/shared/workspaceModules.ts";
import { publicInstallationEndpoints } from "../../../src/shared/installationDomains.ts";
import { portalConfigFromBrand } from "../../../src/shared/portalConfig.ts";
import { platformBrandFromEnv } from "../../../src/shared/platformBrand.ts";
import { json, requireDb } from "../http.ts";
import type { ApiRouteHandler } from "../routeTypes.ts";
import { cacheableUserAvatarUrl } from "../users/avatar.ts";
import { readCatalogImageResponse, type CatalogImageAssetType } from "./coverImage.ts";

export const dispatchCatalogRoutes: ApiRouteHandler = async (context, services, path) => {
  if (context.request.method === "GET" && path === "public/brand") {
    return json({ schemaVersion: 1, brand: platformBrandFromEnv(context.env), modules: workspaceModulesFromEnv(context.env), endpoints: publicInstallationEndpoints(context.env) }, {
      headers: { "Cache-Control": "public, max-age=60" }
    });
  }

  const catalogImageMatch = path.match(/^assets\/(app|skill)\/([^/]+)\/image$/);
  if (context.request.method === "GET" && catalogImageMatch?.[1] && catalogImageMatch[2]) {
    await services.resolveCurrentUser(context);
    const response = await readCatalogImageResponse(
      requireDb(context.env.DB),
      catalogImageMatch[1] as CatalogImageAssetType,
      decodeURIComponent(catalogImageMatch[2]),
      new URL(context.request.url).searchParams.get("v"),
      context.request.headers
    );
    return response ?? json({ error: "catalog_image_not_found" }, { status: 404 });
  }

  if (context.request.method === "GET" && path === "home-bootstrap") {
    const authStartedAt = Date.now();
    const auth = await services.readAuthSession(context);
    const authDuration = Date.now() - authStartedAt;

    if (auth.configured && !auth.authenticated) {
      return json({ auth }, {
        headers: {
          "Cache-Control": "no-store",
          "Server-Timing": `auth;dur=${authDuration}`
        }
      });
    }

    const currentUser = auth.authenticated && "user" in auth
      ? auth.user
      : await services.resolveCurrentUser(context);
    const catalogStartedAt = Date.now();
    const catalog = { ...await services.catalogApi.loadCatalog(context.env.DB, currentUser), portal: portalConfigFromBrand(platformBrandFromEnv(context.env)) };
    const catalogDuration = Date.now() - catalogStartedAt;

    const publicAuth = auth.authenticated && "user" in auth
      ? { ...auth, user: { ...auth.user, avatarUrl: cacheableUserAvatarUrl(auth.user.id, auth.user.avatarUrl) } }
      : auth;
    return json({ auth: publicAuth, catalog, me: catalog.currentUser }, {
      headers: {
        "Cache-Control": "no-store",
        "Server-Timing": `auth;dur=${authDuration}, catalog;dur=${catalogDuration}`
      }
    });
  }

  if (context.request.method === "GET" && path === "catalog") {
    const currentUser = await services.resolveCurrentUser(context);
    return json({ ...await services.catalogApi.loadCatalog(context.env.DB, currentUser), portal: portalConfigFromBrand(platformBrandFromEnv(context.env)) }, {
      headers: { "Cache-Control": "no-store" }
    });
  }

  return undefined;
};
