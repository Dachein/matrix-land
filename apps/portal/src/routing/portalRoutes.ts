export type PortalLandingSection = "home" | "discussions";
export type PortalKnowledgeSection = "my" | "services" | "recent";
export type PortalAdminSection = "tokens" | "allocations" | "usage";
export type PortalNavKey = PortalLandingSection | "catalog" | "models" | "studio" | "mate" | "knowledge" | "connections" | "admin" | "admin-users" | "admin-knowledge" | "admin-mcp-connections" | "admin-hub-review" | "admin-backups" | "admin-login-policy";
export type PortalRoute =
  | { page: "landing"; section: PortalLandingSection }
  | { page: "post"; postId: string }
  | { page: "catalog" }
  | { page: "app"; appId: string }
  | { page: "skill"; skillId: string }
  | { page: "mate-preview"; mateId: string; releaseId: string; debug: boolean; presentation?: "embedded" }
  | { page: "mate-embed"; mateId: string; presentation: "embedded"; conversationId?: string; embedInstanceId?: string }
  | { page: "models" }
  | { page: "model-status" }
  | { page: "studio" }
  | { page: "mate"; mateId?: string; conversationId?: string; artifactId?: string }
  | { page: "knowledge"; section: PortalKnowledgeSection }
  | { page: "connections" }
  | { page: "admin"; section: PortalAdminSection }
  | { page: "admin-users" }
  | { page: "admin-knowledge" }
  | { page: "admin-mcp-connections" }
  | { page: "admin-hub-review" }
  | { page: "admin-backups" }
  | { page: "admin-login-policy" }
  | { page: "not-found" };

const adminPaths = {
  "admin-users": "/admin/people", "admin-knowledge": "/admin/knowledge",
  "admin-mcp-connections": "/admin/integrations", "admin-hub-review": "/admin/publishing",
  "admin-backups": "/admin/operations", "admin-login-policy": "/admin/identity"
} as const;

function coordinate(raw: string | null | undefined) {
  if (!raw) return undefined;
  try {
    const value = decodeURIComponent(raw);
    return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}

export function parsePortalRoute(location: string): PortalRoute {
  if (!location.startsWith("/") || location.startsWith("//") || location.includes("#")) return { page: "not-found" };
  const url = new URL(location, "https://workspace.invalid");
  const path = url.pathname.replace(/\/$/, "") || "/";
  const query = url.searchParams;
  if (path === "/" || path === "/home") return { page: "landing", section: "home" };
  if (path === "/discussions") return { page: "landing", section: "discussions" };
  const post = path.match(/^\/discussions\/([^/]+)$/);
  if (post && coordinate(post[1])) return { page: "post", postId: coordinate(post[1])! };
  if (path === "/catalog") return { page: "catalog" };
  const resource = path.match(/^\/catalog\/(apps|skills)\/([^/]+)$/);
  if (resource && coordinate(resource[2])) return resource[1] === "apps"
    ? { page: "app", appId: coordinate(resource[2])! } : { page: "skill", skillId: coordinate(resource[2])! };
  if (path === "/studio") return { page: "studio" };
  if (path === "/models") return { page: "models" };
  if (path === "/models/status") return { page: "model-status" };
  if (path === "/connections") return { page: "connections" };
  if (path === "/knowledge") return { page: "knowledge", section: "my" };
  if (path === "/knowledge/services") return { page: "knowledge", section: "services" };
  if (path === "/knowledge/recent") return { page: "knowledge", section: "recent" };
  const mate = path.match(/^\/mate(?:\/([^/]+))?(?:\/(embed|preview|conversations)(?:\/([^/]+))?)?$/);
  if (mate) {
    const mateId = coordinate(mate[1]);
    if (mate[1] && !mateId) return { page: "not-found" };
    if (mate[2] === "preview") {
      const releaseId = coordinate(query.get("release"));
      if (!mateId || !releaseId || mate[3]) return { page: "not-found" };
      return { page: "mate-preview", mateId, releaseId, debug: query.get("debug") === "1", ...(query.get("presentation") === "embedded" ? { presentation: "embedded" } : {}) };
    }
    const conversationId = coordinate(mate[2] === "conversations" ? mate[3] : query.get("conversation"));
    if (mate[2] === "conversations" && !conversationId) return { page: "not-found" };
    if (mate[2] === "embed") {
      if (!mateId || mate[3]) return { page: "not-found" };
      const embedInstanceId = coordinate(query.get("embedInstance"));
      return { page: "mate-embed", mateId, presentation: "embedded", ...(conversationId ? { conversationId } : {}), ...(embedInstanceId ? { embedInstanceId } : {}) };
    }
    const artifactId = coordinate(query.get("artifact"));
    return { page: "mate", ...(mateId ? { mateId } : {}), ...(conversationId ? { conversationId } : {}), ...(artifactId ? { artifactId } : {}) };
  }
  if (path === "/admin" || path === "/admin/models") return { page: "admin", section: "tokens" };
  if (path === "/admin/models/allocations") return { page: "admin", section: "allocations" };
  if (path === "/admin/models/usage") return { page: "admin", section: "usage" };
  for (const [page, expected] of Object.entries(adminPaths)) {
    if (path === expected) return { page: page as keyof typeof adminPaths };
  }
  return { page: "not-found" };
}

export function portalRoutePath(route: PortalRoute): string {
  switch (route.page) {
    case "landing": return route.section === "home" ? "/home" : "/discussions";
    case "post": return `/discussions/${encodeURIComponent(route.postId)}`;
    case "catalog": return "/catalog";
    case "app": return `/catalog/apps/${encodeURIComponent(route.appId)}`;
    case "skill": return `/catalog/skills/${encodeURIComponent(route.skillId)}`;
    case "models": return "/models";
    case "model-status": return "/models/status";
    case "studio": return "/studio";
    case "connections": return "/connections";
    case "knowledge": return route.section === "my" ? "/knowledge" : `/knowledge/${route.section}`;
    case "mate-preview": {
      const q = new URLSearchParams({ release: route.releaseId });
      if (route.debug) q.set("debug", "1");
      if (route.presentation) q.set("presentation", route.presentation);
      return `/mate/${encodeURIComponent(route.mateId)}/preview?${q}`;
    }
    case "mate-embed": {
      const q = new URLSearchParams();
      if (route.conversationId) q.set("conversation", route.conversationId);
      if (route.embedInstanceId) q.set("embedInstance", route.embedInstanceId);
      return `/mate/${encodeURIComponent(route.mateId)}/embed${q.size ? `?${q}` : ""}`;
    }
    case "mate": {
      const q = new URLSearchParams();
      if (!route.mateId && route.conversationId) q.set("conversation", route.conversationId);
      if (route.artifactId) q.set("artifact", route.artifactId);
      return `/mate${route.mateId ? `/${encodeURIComponent(route.mateId)}` : ""}${route.mateId && route.conversationId ? `/conversations/${encodeURIComponent(route.conversationId)}` : ""}${q.size ? `?${q}` : ""}`;
    }
    case "admin": return route.section === "tokens" ? "/admin/models" : `/admin/models/${route.section}`;
    case "not-found": return "/not-found";
    default: return adminPaths[route.page];
  }
}

export function browserUrlForPortalRoute(route: PortalRoute, _currentPathname = "/") { return portalRoutePath(route); }
export function navKeyForRoute(route: PortalRoute): PortalNavKey {
  if (route.page === "landing") return route.section;
  if (route.page === "post") return "discussions";
  if (route.page === "app" || route.page === "skill") return "catalog";
  if (route.page === "mate-embed" || route.page === "mate-preview") return "mate";
  if (route.page === "model-status") return "models";
  if (route.page === "not-found") return "home";
  return route.page;
}
