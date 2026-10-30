import type { Env } from "./core/types";
import { corsPreflightResponse, withCorsResponse } from "./core/http";
import { handleAppsWorkerRequest } from "./worker";
import { retryPendingOwnership } from "./ownership/service.ts";

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(retryPendingOwnership(env));
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return corsPreflightResponse(request, env);
    }

    return withCorsResponse(await handleAppsWorkerRequest(request, env, ctx), request, env);
  },
};
