import type { ApiServices } from "./apiServices.ts";
import type { PagesContext } from "./env.ts";

export type ApiRouteHandler = (
  context: PagesContext,
  services: ApiServices,
  path: string
) => Promise<Response | undefined>;
