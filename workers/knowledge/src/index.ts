import type { Env, KnowledgeIndexQueueMessage } from "./types.ts";
import { corsHeaders, withCors, errorResponse } from "./http.ts";
import { handleRequest } from "./routes.ts";
import { cleanupStaleKnowledgeZipImports } from "./imports/zip/cleanup.ts";
import { cleanupExpiredKnowledgeQueryData } from "./query/ledger.ts";
import { dispatchKnowledgeIndexOutbox, completeKnowledgeIndexOutbox, failKnowledgeIndexOutbox } from "./indexing/outbox.ts";
import { processKnowledgeDiffOutbox } from "./audit/diffs.ts";
import { reconcileKnowledgeServiceState } from "./indexing/operations.ts";
import { requireKnowledgeService } from "./services/repository.ts";
import { reindexKnowledgeService } from "./indexing/reindex.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      const response = await handleRequest(request, env, requestId);
      return withCors(response, request, env, requestId);
    } catch (error) {
      return withCors(errorResponse(error, requestId), request, env, requestId);
    }
  },

  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
    context.waitUntil(Promise.all([
      cleanupStaleKnowledgeZipImports(env),
      cleanupExpiredKnowledgeQueryData(env),
      dispatchKnowledgeIndexOutbox(env),
      processKnowledgeDiffOutbox(env, 25),
      reconcileKnowledgeServiceState(env)
    ]));
  },

  async queue(batch: MessageBatch<KnowledgeIndexQueueMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        if (message.body.kind !== "service_reindex") {
          message.ack();
          continue;
        }
        const service = await requireKnowledgeService(env, message.body.serviceId);
        if (service.status !== "active" || service.agent_enabled !== 1) {
          await completeKnowledgeIndexOutbox(env, service.id, message.body.sourceRevision);
          message.ack();
          continue;
        }
        await reindexKnowledgeService(env, service, "knowledge-index-queue");
        await completeKnowledgeIndexOutbox(env, service.id, message.body.sourceRevision);
        message.ack();
      } catch (error) {
        await failKnowledgeIndexOutbox(env, message.body.serviceId, error);
        message.retry();
      }
    }
  }
};

export { applyUnifiedTextPatch } from "./textPatch.ts";
export { assertKnowledgeAdminReadPrincipal } from "./services/admin.ts";
export { renderKnowledgeMarkdown } from "./viewer/render.ts";
