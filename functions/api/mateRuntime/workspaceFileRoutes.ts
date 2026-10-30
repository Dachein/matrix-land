import type { ApiRouteHandler } from "../routeTypes.ts";

// Workspace artifact references are private, authenticated application links.
// A plain browser navigation has no Runtime bearer, so send it to Mate where
// the current user's live session can load and preview the file.
export const dispatchWorkspaceFileRoutes: ApiRouteHandler = async (context, _services, path) => {
  const match = path.match(/^workspace-files\/(art_[0-9a-f-]{36})\/(raw|download)$/);
  if (!match || context.request.method !== "GET") return undefined;
  const target = new URL("/", context.request.url);
  target.hash = `/mate?artifact=${encodeURIComponent(match[1]!)}`;
  return Response.redirect(target.toString(), 302);
};
