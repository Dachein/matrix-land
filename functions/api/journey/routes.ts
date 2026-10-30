import { json } from "../http.ts";
import type { ApiRouteHandler } from "../routeTypes.ts";
import { currentUserSummaryFromJourney } from "./service.ts";

export const dispatchJourneyRoutes: ApiRouteHandler = async (context, services, path) => {
  if (context.request.method === "GET" && path === "me") {
    const overview = await services.journeyApi.readCurrentUserOverview(context);
    return json({
      journey: overview.journey,
      me: { ...overview.currentUser, status: overview.status }
    }, { headers: { "cache-control": "private, no-cache" } });
  }

  if (context.request.method === "GET" && path === "journey") {
    const journey = await services.journeyApi.readCurrentUserJourney(context);
    return json({
      currentUserSummary: currentUserSummaryFromJourney(journey),
      journey
    });
  }

  if (context.request.method === "PATCH" && path === "journey/profile") {
    return json({ journey: await services.journeyApi.updateCurrentUserJourneyProfile(context) });
  }

  return undefined;
};
