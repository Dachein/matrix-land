import {
  processPublicationPublicationOutbox,
  readPublicationPublicationHealth
} from "../../../functions/api/publication/publicationOutbox.ts";

export type Env = {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  DB: D1Database;
  PUBLICATION_AUTH_SERVICE_TOKEN?: string;
};

export async function runPublicationPublicationReconciler(
  env: Env,
  dependencies: {
    clock?: () => Date;
    fetch?: typeof fetch;
    randomUUID?: () => string;
  } = {}
) {
  const results = await processPublicationPublicationOutbox(env.DB, publicationAuthEnv(env), {
    ...dependencies,
    limit: 25
  });
  const failed = results.filter((result) => result.state === "failed");
  if (failed.length > 0) {
    console.warn("publication_publication_reconcile_failed", {
      count: failed.length,
      errorCodes: Array.from(new Set(failed
        .map((result) => result.delivery && !result.delivery.success ? result.delivery.errorCode : "")
        .filter(Boolean)))
    });
  }
  return {
    failed: failed.length,
    processed: results.length,
    results
  };
}

export function publicationAuthEnv(env: Env) {
  return {
    AUTH_SERVICE_TOKEN: env.PUBLICATION_AUTH_SERVICE_TOKEN?.trim() || env.AUTH_SERVICE_TOKEN?.trim(),
    AUTH_WORKER_URL: env.AUTH_WORKER_URL
  };
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }
    const backlog = await readPublicationPublicationHealth(env.DB);
    return Response.json({
      backlog,
      ok: !backlog.some((row) => row.state === "failed")
    });
  },

  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
    context.waitUntil(runPublicationPublicationReconciler(env));
  }
};
