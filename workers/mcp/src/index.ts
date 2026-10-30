import type { Env } from "./types.ts";
import { corsPreflightResponse, withCorsResponse } from "./http.ts";
import { handleWorkspaceMcpWorkerRequest } from "./worker.ts";

export default {
  async fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return corsPreflightResponse(request, env);
    }

    return withCorsResponse(
      await handleWorkspaceMcpWorkerRequest(request, env, executionContext),
      request,
      env
    );
  }
};
