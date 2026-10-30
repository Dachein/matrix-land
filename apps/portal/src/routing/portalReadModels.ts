import type { PortalReadModel } from "../data/portalDataLoader";

export function portalRouteReadModels(page: string): PortalReadModel[] {
  if (page === "catalog") {
    return ["apps", "skills", "hub"];
  }
  if (page === "app") {
    return ["apps", "hub"];
  }
  if (page === "skill") {
    return ["skills", "hub"];
  }
  if (page === "studio") {
    return ["publication"];
  }
  if (page === "admin-hub-review") {
    return ["apps", "skills", "reviewPublication"];
  }
  return [];
}

/** Only these read models must finish before the route's main content is useful. */
export function portalRouteCriticalReadModels(page: string): PortalReadModel[] {
  if (page === "catalog") return ["hub"];
  if (page === "app") return ["apps"];
  if (page === "skill") return ["skills"];
  if (page === "admin-hub-review") return ["apps", "skills", "reviewPublication"];
  // APPS inventory starts inside the mounted route and does not depend on listings.
  return [];
}
