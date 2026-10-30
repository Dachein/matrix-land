import { appAgentResourceContext, buildAppDeveloperContext } from "../../../../src/shared/appsAgentHandoff";
import { deleteAppEnvVars, listAppEnvVars, setAppEnvVars } from "../apps/envVars";
import { appMailSdkHandoff } from "../apps/mailSdk";
import { appAuthSdkHandoff } from "../apps/authSdk";
import { createAppFromInput, patchApp } from "../apps/service";
import {
  applyD1Migration,
  deployPages,
  deployWorkerSource,
  getD1Schema,
  getDeployment,
  listD1Migrations,
  listDeployments,
  publishDeployment,
  rollbackDeployment
} from "../apps/deployments";
import { listApps, readApp } from "../apps/queries";
import { declareAppSecretRequirements } from "../apps/secrets";
import {
  deleteAppKvValue,
  deleteAppR2Object,
  getAppKvValue,
  getAppR2Object,
  listAppKvKeys,
  listAppR2Objects,
  putAppKvValue,
  putAppR2Object
} from "../apps/storage";
import { assertScope, resolvePrincipal } from "../core/auth";
import { JSON_HEADERS, readJson } from "../core/http";
import { APP_READ_SCOPES, APP_WRITE_SCOPES, READ_SCOPES, SKILL_READ_SCOPES, SKILL_WRITE_SCOPES, MATE_READ_SCOPES, MATE_WRITE_SCOPES } from "../core/scopes";
import { HttpError, type Env, type Principal } from "../core/types";
import { asRecord, readString, requireText } from "../core/utils";
import { listManagedInventory } from "../inventory";
import { listLlmModels } from "../llm-gateway/client";
import { readLatestProvisioningJob, readProvisioningJob, retryProvisioningJob } from "../provisioning/service";
import { runProvisioningJob } from "../provisioning/runner";
import { validateSkillPackage, type PublishSkillInput } from "../skills/package";
import { downloadSkillPackage, listSkills, publishSkillPrivate, readSkill } from "../skills/service";
import { activateMateRelease, createMate, deployMatePreview, listMateReleases, listMates, patchMate, publishMateRelease, readMate, reviewMateCore, mateAdoptionPreview, updateMateCore, updateMateDraft, validateMateDraft } from "../mates/service";
import { jsonRpcError, jsonRpcResult, mcpPlainTextResult, mcpTextResult, mcpToolErrorResult, type McpToolError } from "./protocol";
import { mcpTools } from "./tools";

export async function handleMcpRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const rpc = await readJson<{ id?: string | number | null; method?: string; params?: unknown }>(request);
  const id = rpc.id ?? null;
  const method = readString(rpc.method);
  const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();

  if (method === "notifications/initialized") {
    return new Response(null, { status: 202, headers: JSON_HEADERS });
  }

  try {
    const principal = await resolvePrincipal(request, env);

    if (method === "initialize") {
      return jsonRpcResult(id, {
        protocolVersion: "2025-03-26",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "workspace-apps",
          version: "0.1.0"
        }
      });
    }

    if (method === "ping") {
      return jsonRpcResult(id, {});
    }

    if (method === "tools/list") {
      assertScope(principal, [...READ_SCOPES, ...MATE_READ_SCOPES]);
      return jsonRpcResult(id, { tools: mcpTools() });
    }

    if (method === "tools/call") {
      const params = asRecord(rpc.params);
      const name = readString(params.name);
      const args = asRecord(params.arguments);
      try {
        return jsonRpcResult(id, await callMcpTool(name, args, env, principal, ctx));
      } catch (error) {
        if (error instanceof HttpError && error.code === "unknown_mcp_tool") {
          return jsonRpcError(id, -32602, error.code);
        }
        console.warn("apps_mcp_tool_error", {
          code: error instanceof HttpError ? error.code : "mcp_tool_error",
          requestId,
          toolName: name
        });
        return jsonRpcResult(id, mcpToolErrorResult(toMcpToolError(error, name, args, requestId)));
      }
    }

    return jsonRpcError(id, -32601, "Method not found");
  } catch (error) {
    if (error instanceof HttpError) {
      console.warn("apps_mcp_http_error", { code: error.code, status: error.status });
      return jsonRpcError(id, error.status === 403 ? -32003 : -32001, error.code, {
        ...error.details,
        code: error.code,
        status: error.status
      });
    }

    const message = error instanceof Error ? error.message : "mcp_tool_error";
    console.warn("apps_mcp_unhandled_error", { message });
    return jsonRpcError(id, -32000, message, { code: "mcp_tool_error" });
  }
}

function toMcpToolError(
  error: unknown,
  operation: string,
  args: Record<string, unknown>,
  requestId: string
): McpToolError {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : "mcp_tool_error";
  const appId = readString(args.appId).trim();
  const isAuthPreflight = code === "auth_security_preflight_failed";
  const details = error instanceof HttpError ? error.details : undefined;
  const auth = details?.security && typeof details.security === "object"
    ? (details.security as Record<string, unknown>).auth
    : undefined;
  const report = auth && typeof auth === "object" ? auth as Record<string, unknown> : undefined;
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const firstFinding = findings.find((finding) => finding && typeof finding === "object") as Record<string, unknown> | undefined;
  const summary = readString(firstFinding?.message).trim()
    || (isAuthPreflight ? "Workspace Auth integration could not be verified in the deployment bundle." : code);

  if (isAuthPreflight) {
    return {
      schemaVersion: "workspace.mcp.error.v1",
      code,
      category: "validation",
      status,
      retryable: false,
      operation,
      requestId,
      ...(appId ? { resource: { type: "apps_app", id: appId } } : {}),
      summary,
      ...(details ? { details } : {}),
      handoff: {
        state: "action_required",
        nextAction: {
          kind: "tool_call",
          tool: "apps_get_app",
          arguments: appId ? { appId } : {},
          reason: "Refresh the canonical App context, readiness, managed-secret lifecycle, blockers, and next actions before changing Auth implementation.",
          requiresUserApproval: false
        },
        afterSuccess: [
          "Review developerContext.auth, readiness, blockers, and nextActions.",
          "If developerContext.nextActions includes apps_get_auth_sdk, call it and install the returned versioned @frontier-workspace/auth package.",
          operation === "apps_pages_deploy"
            ? "Integrate WorkspaceBrowserAppSession in the deployed Pages _worker.bundle."
            : "Integrate WorkspaceBrowserAppSession or WorkspaceAuthResource in the executable Worker entrypoint.",
          "Build an inspectable deployment bundle and verify that authentication fails closed.",
          "Ask for approval before retrying the deployment."
        ],
        retry: {
          tool: operation,
          requiresUserApproval: true,
          reuseOriginalArguments: true
        }
      }
    };
  }

  const category = status === 401 || status === 403
    ? "authorization"
    : status === 409
      ? "conflict"
      : status >= 500
        ? "internal"
        : "validation";
  const retryable = status === 429 || status >= 500;
  return {
    schemaVersion: "workspace.mcp.error.v1",
    code,
    category,
    status,
    retryable,
    operation,
    requestId,
    ...(appId ? { resource: { type: "apps_app", id: appId } } : {}),
    summary,
    ...(details ? { details } : {}),
    handoff: {
      state: retryable ? "retry_available" : "blocked",
      nextAction: {
        kind: retryable ? "wait_retry" : status === 401 || status === 403 ? "user_action" : "contact_support",
        reason: retryable
          ? "Retry after a short delay; use the requestId if the failure persists."
          : status === 401 || status === 403
            ? "Ask the user or an administrator to grant the required access."
            : "Use the requestId to inspect server logs or contact Workspace support.",
        requiresUserApproval: true
      }
    }
  };
}

async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  principal: Principal,
  ctx: ExecutionContext
) {
  if (name === "apps_list_inventory") {
    assertScope(principal, APP_READ_SCOPES);
    assertScope(principal, SKILL_READ_SCOPES);
    return mcpTextResult(await listManagedInventory(env, principal));
  }

  if (name === "apps_list_apps") {
    assertScope(principal, READ_SCOPES);
    return mcpTextResult({ apps: await listApps(env.APPS_DB, env, principal) });
  }

  if (name === "apps_get_app") {
    assertScope(principal, READ_SCOPES);
    const appId = requireText(args.appId, "missing_app_id", 120);
    const app = await readApp(env.APPS_DB, env, principal, appId);
    return mcpTextResult({ app, developerContext: buildAppDeveloperContext(app) });
  }

  if (name === "apps_update_app_config") {
    assertScope(principal, APP_WRITE_SCOPES);
    const appId = requireText(args.appId, "missing_app_id", 120);
    const request = new Request(`https://apps.local/apps/${encodeURIComponent(appId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        addResourceTypes: Array.isArray(args.addResourceTypes)
          ? args.addResourceTypes.map((type) => readString(type))
          : undefined,
        agentMcpEnabled: args.agentMcpEnabled === undefined ? undefined : args.agentMcpEnabled === true,
        directoryReadScope: args.directoryReadScope === undefined ? undefined : readString(args.directoryReadScope),
        emailEnabled: args.emailEnabled === undefined ? undefined : args.emailEnabled === true,
        emailPrefix: args.emailPrefix === undefined ? undefined : readString(args.emailPrefix),
        emailTriggerEnabled: args.emailTriggerEnabled === undefined ? undefined : args.emailTriggerEnabled === true,
        emailRoutingEnabled: args.emailRoutingEnabled === undefined ? undefined : args.emailRoutingEnabled === true,
        emailRoutingPrefix: readString(args.emailRoutingPrefix),
        emailSenderMailbox: readString(args.emailSenderMailbox),
        emailSendingEnabled: args.emailSendingEnabled === undefined ? undefined : args.emailSendingEnabled === true,
        llmEnabled: args.llmEnabled === undefined ? undefined : args.llmEnabled === true
      })
    });
    return mcpTextResult({ app: await patchApp(request, env, principal, appId) });
  }

  if (name === "apps_list_llm_models") {
    assertScope(principal, READ_SCOPES);
    return mcpTextResult(await listLlmModels(env));
  }

  if (name === "apps_create_app") {
    assertScope(principal, APP_WRITE_SCOPES);
    const result = await createAppFromInput({
      accessMode: readString(args.accessMode),
      accessTargets: Array.isArray(args.accessTargets) ? args.accessTargets.map((target) => readString(target)) : undefined,
      agentMcpEnabled: args.agentMcpEnabled === true,
      emailEnabled: args.emailEnabled === true,
      emailPrefix: readString(args.emailPrefix),
      emailTriggerEnabled: args.emailTriggerEnabled === true,
      code: readString(args.code),
      description: readString(args.description),
      directoryReadScope: readString(args.directoryReadScope),
      loginRequired: args.loginRequired === undefined ? undefined : args.loginRequired !== false,
      llmEnabled: args.llmEnabled === true,
      name: readString(args.name),
      resourceTypes: Array.isArray(args.resourceTypes) ? args.resourceTypes.map((type) => readString(type)) : undefined,
      type: readString(args.type),
      visibility: readString(args.visibility)
    }, env, principal, ctx);
    ctx.waitUntil(runProvisioningJob(env, result.provisioningJob.id));
    return mcpTextResult(result);
  }

  if (name === "apps_list_mates") {
    assertScope(principal, MATE_READ_SCOPES);
    return mcpTextResult({ mates: await listMates(env.APPS_DB, principal) });
  }

  if (name === "apps_mate_create") {
    assertScope(principal, MATE_WRITE_SCOPES);
    return mcpTextResult({ mate: await createMate(args, env, principal) });
  }

  if (name === "apps_mate_get") {
    assertScope(principal, MATE_READ_SCOPES);
    const mateId = requireText(args.mateId, "missing_mate_id", 128);
    return mcpTextResult({ mate: await readMate(env.APPS_DB, principal, mateId, true) });
  }

  if (name === "apps_mate_update") {
    assertScope(principal, MATE_WRITE_SCOPES);
    const mateId = requireText(args.mateId, "missing_mate_id", 128);
    return mcpTextResult({ mate: await patchMate(args, env, principal, mateId) });
  }

  if (name === "apps_mate_core_review") {
    assertScope(principal, MATE_READ_SCOPES);
    const mateId = requireText(args.mateId, "missing_mate_id", 128);
    return mcpTextResult(await reviewMateCore(env.APPS_DB, principal, mateId));
  }

  if (name === "apps_mate_core_update") {
    assertScope(principal, MATE_WRITE_SCOPES);
    const mateId = requireText(args.mateId, "missing_mate_id", 128);
    return mcpTextResult({ mate: await updateMateCore(args, env, principal, mateId) });
  }

  if (name === "apps_mate_definition_update") {
    assertScope(principal, MATE_WRITE_SCOPES);
    const mateId = requireText(args.mateId, "missing_mate_id", 128);
    return mcpTextResult({ mate: await updateMateDraft({
      documents: args.documents,
      expectedRevision: args.expectedRevision,
      manifest: args.manifest
    }, env, principal, mateId) });
  }

  if (name === "apps_mate_validate") {
    assertScope(principal, MATE_WRITE_SCOPES);
    const mateId = requireText(args.mateId, "missing_mate_id", 128);
    return mcpTextResult({ validation: await validateMateDraft(env, principal, mateId) });
  }

  if (name === "apps_mate_deploy_preview") {
    assertScope(principal, MATE_WRITE_SCOPES);
    requireConfirmation(args);
    const mateId = requireText(args.mateId, "missing_mate_id", 128);
    const release = await deployMatePreview(env, principal, mateId);
    return mcpTextResult({ adoptionPreview: mateAdoptionPreview(env, release), release });
  }

  if (name === "apps_mate_publish") {
    assertScope(principal, MATE_WRITE_SCOPES);
    requireConfirmation(args);
    const mateId = requireText(args.mateId, "missing_mate_id", 128);
    const releaseId = requireText(args.releaseId, "missing_release_id", 128);
    return mcpTextResult({ release: await publishMateRelease(env, principal, mateId, releaseId) });
  }

  if (name === "apps_mate_releases_list") {
    assertScope(principal, MATE_READ_SCOPES);
    const mateId = requireText(args.mateId, "missing_mate_id", 128);
    return mcpTextResult({ releases: await listMateReleases(env, principal, mateId) });
  }

  if (name === "apps_mate_release_activate") {
    assertScope(principal, MATE_WRITE_SCOPES);
    requireConfirmation(args);
    const mateId = requireText(args.mateId, "missing_mate_id", 128);
    const releaseId = requireText(args.releaseId, "missing_release_id", 128);
    return mcpTextResult({ release: await activateMateRelease(env, principal, mateId, releaseId) });
  }

  if (name === "apps_secrets_status" || name === "apps_get_app_secret_status") {
    assertScope(principal, READ_SCOPES);
    const appId = requireText(args.appId, "missing_app_id", 120);
    const app = await readApp(env.APPS_DB, env, principal, appId);
    return mcpTextResult({
      secrets: app.secrets,
      managedSecrets: buildAppDeveloperContext(app).auth.managedSecrets
    });
  }

  if (name === "apps_secrets_declare" || name === "apps_declare_app_secret_requirements") {
    assertScope(principal, APP_WRITE_SCOPES);
    const appId = requireText(args.appId, "missing_app_id", 120);
    const request = new Request("https://apps.local/secrets/requirements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secrets: Array.isArray(args.secrets) ? args.secrets : [] })
    });
    return mcpTextResult({ app: await declareAppSecretRequirements(request, env, principal, appId) });
  }

  if (name === "apps_list_skills") {
    assertScope(principal, READ_SCOPES);
    return mcpTextResult({ skills: await listSkills(env.APPS_DB, principal) });
  }

  if (name === "apps_get_skill") {
    assertScope(principal, READ_SCOPES);
    const skillId = requireText(args.skillId, "missing_skill_id", 120);
    return mcpTextResult({ skill: await readSkill(env.APPS_DB, principal, skillId) });
  }

  if (name === "apps_skill_validate") {
    assertScope(principal, SKILL_WRITE_SCOPES);
    return mcpTextResult(validateSkillPackage(args));
  }

  if (name === "apps_skill_submit" || name === "apps_skill_update") {
    assertScope(principal, SKILL_WRITE_SCOPES);
    return mcpTextResult({ skill: await publishSkillPrivate(args as PublishSkillInput, env, principal) });
  }

  if (name === "apps_download_skill_package") {
    assertScope(principal, READ_SCOPES);
    const skillId = requireText(args.skillId, "missing_skill_id", 120);
    const version = requireText(args.version, "missing_version", 40);
    const client = readString(args.client) || "codex";
    return mcpTextResult(await downloadSkillPackage(env, principal, skillId, version, client));
  }

  if (name === "apps_get_service_context") {
    assertScope(principal, READ_SCOPES);
    const appId = requireText(args.appId, "missing_app_id", 120);
    const app = await readApp(env.APPS_DB, env, principal, appId);
    return mcpTextResult(app.manifest);
  }

  if (name === "apps_get_app_handoff") {
    assertScope(principal, READ_SCOPES);
    const appId = requireText(args.appId, "missing_app_id", 120);
    const app = await readApp(env.APPS_DB, env, principal, appId);
    return mcpPlainTextResult(appAgentResourceContext(app));
  }

  if (name === "apps_get_mail_sdk") {
    assertScope(principal, APP_READ_SCOPES);
    return mcpTextResult(appMailSdkHandoff(await readApp(env.APPS_DB,env,principal,requireText(args.appId,"missing_app_id",120))));
  }
  if (name === "apps_get_auth_sdk") {
    assertScope(principal, READ_SCOPES);
    const appId = requireText(args.appId, "missing_app_id", 120);
    const app = await readApp(env.APPS_DB, env, principal, appId);
    return mcpTextResult(appAuthSdkHandoff(app));
  }

  if (name === "apps_pages_deploy") {
    assertScope(principal, ["apps:apps:write", "apps:apps:admin"]);
    assertScope(principal, ["apps:deploy:production", "apps:apps:admin"]);
    return mcpTextResult(await deployPages(args, env, principal));
  }

  if (name === "apps_worker_deploy") {
    assertScope(principal, ["apps:apps:write", "apps:apps:admin"]);
    assertScope(principal, ["apps:deploy:production", "apps:apps:admin"]);
    return mcpTextResult(await deployWorkerSource(args, env, principal));
  }

  if (name === "apps_deployments_list") {
    assertScope(principal, READ_SCOPES);
    return mcpTextResult(await listDeployments(args, env, principal));
  }

  if (name === "apps_deployments_get") {
    assertScope(principal, READ_SCOPES);
    return mcpTextResult(await getDeployment(args, env, principal));
  }

  if (name === "apps_deployments_publish") {
    assertScope(principal, ["apps:deploy:production", "apps:apps:admin"]);
    return mcpTextResult(await publishDeployment(args, env, principal));
  }

  if (name === "apps_deployments_rollback") {
    assertScope(principal, ["apps:deploy:production", "apps:apps:admin"]);
    return mcpTextResult(await rollbackDeployment(args, env, principal));
  }

  if (name === "apps_d1_migrations_apply") {
    assertScope(principal, ["apps:apps:write", "apps:apps:admin"]);
    assertScope(principal, ["apps:deploy:production", "apps:apps:admin"]);
    return mcpTextResult(await applyD1Migration(args, env, principal));
  }

  if (name === "apps_d1_migrations_list") {
    assertScope(principal, READ_SCOPES);
    return mcpTextResult(await listD1Migrations(args, env, principal));
  }

  if (name === "apps_d1_schema_get") {
    assertScope(principal, READ_SCOPES);
    return mcpTextResult(await getD1Schema(args, env, principal));
  }

  if (name === "apps_env_vars_list") {
    assertScope(principal, READ_SCOPES);
    return mcpTextResult(await listAppEnvVars(env, principal, args.appId, args.target));
  }

  if (name === "apps_env_vars_set") {
    assertScope(principal, APP_WRITE_SCOPES);
    return mcpTextResult(await setAppEnvVars(args, env, principal));
  }

  if (name === "apps_env_vars_delete") {
    assertScope(principal, APP_WRITE_SCOPES);
    return mcpTextResult(await deleteAppEnvVars(args, env, principal));
  }

  if (name === "apps_kv_keys_list") {
    assertScope(principal, READ_SCOPES);
    return mcpTextResult(await listAppKvKeys(args, env, principal));
  }

  if (name === "apps_kv_value_get") {
    assertScope(principal, READ_SCOPES);
    return mcpTextResult(await getAppKvValue(args, env, principal));
  }

  if (name === "apps_kv_value_put") {
    assertScope(principal, APP_WRITE_SCOPES);
    return mcpTextResult(await putAppKvValue(args, env, principal));
  }

  if (name === "apps_kv_value_delete") {
    assertScope(principal, APP_WRITE_SCOPES);
    return mcpTextResult(await deleteAppKvValue(args, env, principal));
  }

  if (name === "apps_r2_objects_list") {
    assertScope(principal, READ_SCOPES);
    return mcpTextResult(await listAppR2Objects(args, env, principal));
  }

  if (name === "apps_r2_object_get") {
    assertScope(principal, READ_SCOPES);
    return mcpTextResult(await getAppR2Object(args, env, principal));
  }

  if (name === "apps_r2_object_put") {
    assertScope(principal, APP_WRITE_SCOPES);
    return mcpTextResult(await putAppR2Object(args, env, principal));
  }

  if (name === "apps_r2_object_delete") {
    assertScope(principal, APP_WRITE_SCOPES);
    return mcpTextResult(await deleteAppR2Object(args, env, principal));
  }

  if (name === "apps_get_provisioning_status") {
    assertScope(principal, READ_SCOPES);
    const jobId = readString(args.jobId).trim();
    const appId = readString(args.appId).trim();
    const provisioningJob = jobId
      ? await readProvisioningJob(env.APPS_DB, principal, jobId)
      : await readLatestProvisioningJob(env.APPS_DB, principal, appId);
    return mcpTextResult({ provisioningJob });
  }

  if (name === "apps_retry_provisioning_job") {
    assertScope(principal, APP_WRITE_SCOPES);
    const jobId = requireText(args.jobId, "missing_job_id", 120);
    return mcpTextResult({ provisioningJob: await retryProvisioningJob(env, principal, jobId, ctx) });
  }

  throw new HttpError(404, "unknown_mcp_tool");
}

function requireConfirmation(args: Record<string, unknown>) {
  if (args.confirm !== true) throw new HttpError(409, "explicit_user_confirmation_required");
}
