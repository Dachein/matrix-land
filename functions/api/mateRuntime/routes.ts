import { json } from "../http.ts";
import type { ApiRouteHandler } from "../routeTypes.ts";

export const dispatchMateRuntimeRoutes: ApiRouteHandler = async (context, services, path) => {
  if (context.request.method === "POST" && path === "mate-runtime/live-sessions") {
    const payload = await services.matePreviewSessionApi.createLiveSession(context);
    return json(payload, {
      headers: {
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer"
      },
      status: 201
    });
  }
  if (context.request.method === "POST" && path === "mate-runtime/preview-sessions") {
    const payload = await services.matePreviewSessionApi.createPreviewSession(context);
    return json(payload, {
      headers: {
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer"
      },
      status: 201
    });
  }
  return undefined;
};
