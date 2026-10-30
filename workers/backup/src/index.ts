import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { resolvePrincipal, requireAdmin } from "./auth";
import { claimNextDelivery, downloadAgentArtifact, finishDelivery, requireTransferAgent } from "./agent";
import { createAppManualBackupJob, createBackupJob, executeBackupJob, retryBackupJob, runDueBackups } from "./executor";
import { errorResponse, json, normalizePath } from "./http";
import {
  assignNode, createNode, downloadArtifact, downloadJobArchive, listAdminApps, listAdminJobs, listArtifacts, listNodes,
  readAppBackup, testNode, updateAppBackup, updateNode
} from "./service";
import type { BackupWorkflowParams, Env } from "./types";
import { HttpError } from "./types";

export class AppBackupWorkflow extends WorkflowEntrypoint<Env, BackupWorkflowParams> {
  async run(event: WorkflowEvent<BackupWorkflowParams>, step: WorkflowStep) {
    return step.do(
      "create-cloudflare-backup-set",
      { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "30 minutes" },
      () => executeBackupJob(this.env, event.payload.jobId)
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const requestId = crypto.randomUUID();
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      const path = normalizePath(new URL(request.url).pathname);
      if (path === "/health") return json({ ok: true, service: "workspace-backup-worker" });
      if (path === "/agent/deliveries/next" && request.method === "POST") {
        await requireTransferAgent(request, env);
        return json(await claimNextDelivery(env));
      }
      let agentMatch = path.match(/^\/agent\/deliveries\/([^/]+)\/artifacts\/([^/]+)$/);
      if (agentMatch && request.method === "GET") {
        await requireTransferAgent(request, env);
        return downloadAgentArtifact(env, decodeURIComponent(agentMatch[1]), decodeURIComponent(agentMatch[2]));
      }
      agentMatch = path.match(/^\/agent\/deliveries\/([^/]+)\/complete$/);
      if (agentMatch && request.method === "POST") {
        await requireTransferAgent(request, env);
        return json(await finishDelivery(request, env, decodeURIComponent(agentMatch[1])));
      }
      const principal = await resolvePrincipal(request, env);

      let match = path.match(/^\/apps\/([^/]+)\/backup$/);
      if (match && request.method === "GET") return json(await readAppBackup(env, principal, decodeURIComponent(match[1])));
      if (match && request.method === "PUT") return json(await updateAppBackup(request, env, principal, decodeURIComponent(match[1])));
      match = path.match(/^\/apps\/([^/]+)\/backups\/run$/);
      if (match && request.method === "POST") {
        return json(await createAppManualBackupJob(env, principal, decodeURIComponent(match[1])), { status: 202 });
      }
      match = path.match(/^\/apps\/([^/]+)\/backups\/([^/]+)\/artifacts$/);
      if (match && request.method === "GET") return json(await listArtifacts(env, principal, decodeURIComponent(match[1]), decodeURIComponent(match[2])));
      match = path.match(/^\/apps\/([^/]+)\/backups\/([^/]+)\/download$/);
      if (match && request.method === "GET") return downloadJobArchive(env, principal, decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      match = path.match(/^\/apps\/([^/]+)\/backups\/([^/]+)\/artifacts\/([^/]+)\/download$/);
      if (match && request.method === "GET") return downloadArtifact(env, principal, decodeURIComponent(match[1]), decodeURIComponent(match[2]), decodeURIComponent(match[3]));

      if (path === "/admin/apps" && request.method === "GET") return json(await listAdminApps(env, principal));
      if (path === "/admin/jobs" && request.method === "GET") return json(await listAdminJobs(env, principal));
      if (path === "/admin/nodes" && request.method === "GET") return json(await listNodes(env, principal));
      if (path === "/admin/nodes" && request.method === "POST") return json(await createNode(request, env, principal), { status: 201 });
      match = path.match(/^\/admin\/nodes\/([^/]+)$/);
      if (match && request.method === "PATCH") return json(await updateNode(request, env, principal, decodeURIComponent(match[1])));
      match = path.match(/^\/admin\/nodes\/([^/]+)\/test$/);
      if (match && request.method === "POST") return json(await testNode(env, principal, decodeURIComponent(match[1])));
      match = path.match(/^\/admin\/apps\/([^/]+)\/node$/);
      if (match && request.method === "PATCH") return json(await assignNode(request, env, principal, decodeURIComponent(match[1])));
      match = path.match(/^\/admin\/apps\/([^/]+)\/run$/);
      if (match && request.method === "POST") {
        requireAdmin(principal);
        return json(await createBackupJob(env, principal, decodeURIComponent(match[1]), "manual"), { status: 202 });
      }
      match = path.match(/^\/admin\/jobs\/([^/]+)\/retry$/);
      if (match && request.method === "POST") {
        requireAdmin(principal);
        return json(await retryBackupJob(env, principal, decodeURIComponent(match[1])), { status: 202 });
      }
      throw new HttpError(404, "backup_route_not_found");
    } catch (error) {
      return errorResponse(error, requestId);
    }
  },
  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext) {
    context.waitUntil(runDueBackups(env, new Date(controller.scheduledTime)));
  }
};
