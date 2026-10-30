import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import {
  parseWorkspaceAppMcpManifest,
  type WorkspaceAppMcpManifest,
  type WorkspaceAppMcpTool
} from "../../../src/shared/appMcpManifest.ts";
import type { WorkspaceAgentRuntimeManifest } from "../../../src/shared/mate.ts";
import {
  completeToolAudit,
  concludeTask,
  consumeApproval,
  createApproval,
  decideApproval,
  readApproval,
  readTask,
  resumeTaskAfterApproval,
  startTask,
  startToolAudit
} from "./storage.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimeMode, type RuntimePrincipal } from "./types.ts";

type AppMcpOperation = {
  appId: string;
  arguments: Record<string, unknown>;
  toolName: string;
  type: "app_mcp_tool_call";
};

type PreparedAppMcpCall = {
  actionDigest: string;
  manifest: WorkspaceAppMcpManifest;
  manifestSha256: string;
  operation: AppMcpOperation;
  policyVersion?: string;
  releaseId: string;
  token: string;
  tool: WorkspaceAppMcpTool;
};

export async function listRuntimeAppMcpBindings(
  env: RuntimeEnv, principal: RuntimePrincipal, definition: RuntimeDefinition
): Promise<WorkspaceAgentRuntimeManifest["resources"]["appMcpBindings"]> {
  if (definition.release.manifest.resources.appMcpScope?.mode !== "all_visible_to_invoking_user") {
    return definition.release.manifest.resources.appMcpBindings;
  }
  const token = env.MATE_RUNTIME_SERVICE_TOKEN?.trim();
  if (!token) throw new RuntimeHttpError(503, "control_plane_service_token_not_configured");
  const origin = validatedOrigin(env.APPS_CONTROL_PLANE_URL || missingConfiguration("APPS_CONTROL_PLANE_URL"), "apps_control_plane_url_invalid");
  const headers = runtimeAppHeaders(token, principal);
  const request = new Request(`${origin}/internal/runtime/app-mcp`, { headers });
  const response = env.APPS_CONTROL_PLANE ? await env.APPS_CONTROL_PLANE.fetch(request) : await fetch(request);
  if (!response.ok) throw new RuntimeHttpError(response.status === 401 ? 502 : response.status, "app_mcp_list_failed");
  const payload = record(await response.json());
  if (!Array.isArray(payload.apps)) throw new RuntimeHttpError(502, "app_mcp_list_invalid");
  return payload.apps.map((item) => {
    const app = record(item);
    const appId = text(app.appId);
    const manifestVersion = text(app.manifestVersion);
    if (!appId || !manifestVersion) throw new RuntimeHttpError(502, "app_mcp_list_invalid");
    return { appId, manifestVersion, authority: { mode: "invoking_user" as const }, requiresCurrentUserDelegation: true as const };
  });
}

/** Resolve one Release-bound App against the invoking user's live App RBAC. */
export async function resolveVisibleAppMcpBinding(
  env: RuntimeEnv,
  principal: RuntimePrincipal,
  binding: WorkspaceAgentRuntimeManifest["resources"]["appMcpBindings"][number]
) {
  const registered = await readRegisteredApp(env, principal, binding.appId);
  if (registered.manifest.schemaVersion !== binding.manifestVersion) {
    throw new RuntimeHttpError(409, "app_mcp_manifest_version_changed");
  }
  const discoveryToken = await mintAppResourceToken(env, principal, registered.manifest, [
    registered.manifest.authorization.toolsEndpointScope
  ]);
  const effective = await fetchEffectiveTools(env, registered.manifest, discoveryToken);
  const releaseToolNames = binding.allowedToolNames?.length
    ? new Set(binding.allowedToolNames)
    : undefined;
  const allowedToolNames = [...effective.toolNames]
    .filter((toolName) => !releaseToolNames || releaseToolNames.has(toolName));
  return {
    allowedToolNames,
    authorization: "invoking_user" as const,
    description: registered.manifest.description ?? "",
    id: binding.appId,
    kind: "app_mcp" as const,
    name: registered.manifest.name
  };
}

/**
 * Resolve the App MCP tools that may participate in a Conversation turn.
 * Conversation defaults to read-only. The Task Agent also discovers write
 * tools, whose execution still passes through the Task + Approval adapter.
 */
export async function resolveConversationAppMcpBinding(
  env: RuntimeEnv,
  principal: RuntimePrincipal,
  binding: WorkspaceAgentRuntimeManifest["resources"]["appMcpBindings"][number],
  includeWrites = false
) {
  const registered = await readRegisteredApp(env, principal, binding.appId);
  if (registered.manifest.schemaVersion !== binding.manifestVersion) {
    throw new RuntimeHttpError(409, "app_mcp_manifest_version_changed");
  }
  const discoveryToken = await mintAppResourceToken(env, principal, registered.manifest, [
    registered.manifest.authorization.toolsEndpointScope
  ]);
  const effective = await fetchEffectiveTools(env, registered.manifest, discoveryToken);
  const releaseToolNames = binding.allowedToolNames?.length
    ? new Set(binding.allowedToolNames)
    : undefined;
  return {
    appId: binding.appId,
    description: registered.manifest.description ?? "",
    name: registered.manifest.name,
    tools: registered.manifest.tools.filter((tool) => (
      (includeWrites || tool.readOnly)
      && effective.toolNames.has(tool.name)
      && (!releaseToolNames || releaseToolNames.has(tool.name))
    ))
  };
}

/** Execute one previously advertised, Release-bound read tool as the invoking user. */
export async function executeConversationAppMcpRead(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  input: { appId: string; arguments: Record<string, unknown>; toolName: string }
) {
  assertNoCallerAuthority(input.arguments);
  const binding = (await listRuntimeAppMcpBindings(env, principal, definition)).find((candidate) => candidate.appId === input.appId);
  if (!binding) throw new RuntimeHttpError(403, "mate_app_mcp_not_bound");
  const registered = await readRegisteredApp(env, principal, binding.appId);
  if (registered.manifest.schemaVersion !== binding.manifestVersion) {
    throw new RuntimeHttpError(409, "app_mcp_manifest_version_changed");
  }
  const tool = registered.manifest.tools.find((candidate) => candidate.name === input.toolName);
  if (!tool || !tool.readOnly) throw new RuntimeHttpError(403, "mate_chat_app_mcp_tool_not_allowed");
  if (binding.allowedToolNames?.length && !binding.allowedToolNames.includes(tool.name)) {
    throw new RuntimeHttpError(403, "mate_app_mcp_tool_not_allowed");
  }
  validateInput(input.arguments, tool.inputSchema);
  const discoveryToken = await mintAppResourceToken(env, principal, registered.manifest, [
    registered.manifest.authorization.toolsEndpointScope
  ]);
  const effective = await fetchEffectiveTools(env, registered.manifest, discoveryToken);
  if (!effective.toolNames.has(tool.name)) throw new RuntimeHttpError(403, "app_mcp_tool_role_required");
  const prepared: PreparedAppMcpCall = {
    actionDigest: `sha256:${await sha256Hex(stableJson({
      appId: binding.appId,
      arguments: input.arguments,
      manifestSha256: registered.manifestSha256,
      releaseId: definition.release.id,
      toolDefinitionVersion: registered.manifest.toolDefinitionVersion,
      toolName: tool.name
    }))}`,
    manifest: registered.manifest,
    manifestSha256: registered.manifestSha256,
    operation: {
      appId: binding.appId,
      arguments: input.arguments,
      toolName: tool.name,
      type: "app_mcp_tool_call"
    },
    policyVersion: effective.policyVersion,
    releaseId: definition.release.id,
    token: await mintAppResourceToken(env, principal, registered.manifest, tool.requiredScopes, tool.name),
    tool
  };
  return {
    app: { appId: binding.appId, name: registered.manifest.name },
    output: await callRegisteredTool(env, prepared),
    tool: { name: tool.name, readOnly: true }
  };
}

export async function executeAppMcpTask(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string,
  input: Record<string, unknown>
) {
  const mateId = definition.mate.id;
  const { task } = await startTask(env.RUNTIME_DB, mateId, principal, mode, taskId, definition.release.id);
  try {
    const operation = requestedOperation(input);
    let prepared = await prepareAppMcpCall(env, definition, principal, task, operation, false);
    if (requiresApproval(definition.release.manifest as WorkspaceAgentRuntimeManifest, prepared.tool)) {
      if (mode === "preview") throw new RuntimeHttpError(409, "preview_app_mcp_write_not_allowed");
      const approval = await createApproval(env.RUNTIME_DB, mateId, principal, mode, taskId, {
        actionDigest: prepared.actionDigest,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        manifestSha256: prepared.manifestSha256,
        operation,
        policyVersion: prepared.policyVersion,
        releaseId: prepared.releaseId,
        riskLevel: prepared.tool.riskLevel,
        toolDefinitionVersion: prepared.manifest.toolDefinitionVersion
      });
      return {
        approval,
        task: await readTask(env.RUNTIME_DB, mateId, principal, mode, taskId)
      };
    }
    prepared = await addExecutionToken(env, principal, prepared);
    return performPreparedCall(env, definition, principal, mode, taskId, prepared);
  } catch (error) {
    return failedExecution(env, definition, principal, mode, taskId, error);
  }
}

export async function decideAndExecuteAppMcpApproval(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  approvalId: string,
  decision: unknown
) {
  const mateId = definition.mate.id;
  const approval = await decideApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId, decision);
  const taskId = text(approval.taskId);
  if (approval.status === "denied") {
    const task = await concludeTask(env.RUNTIME_DB, mateId, principal.userId, mode, taskId, {
      actions: [],
      artifacts: [],
      failures: [{ approvalId, code: "app_mcp_action_denied" }],
      followUps: [],
      outcome: "cancelled",
      pendingApprovals: [],
      summary: "该 App 操作未获当前用户批准，任务已取消。"
    });
    return { approval, task };
  }

  try {
    const operation = approvalOperation(approval.operation);
    const task = await readTask(env.RUNTIME_DB, mateId, principal, mode, taskId);
    if (text(approval.releaseId) !== definition.release.id || task.releaseId !== definition.release.id) {
      throw new RuntimeHttpError(409, "approval_release_changed");
    }
    const prepared = await prepareAppMcpCall(env, definition, principal, task, operation, true);
    if (
      prepared.actionDigest !== approval.actionDigest
      || prepared.manifestSha256 !== approval.manifestSha256
      || prepared.manifest.toolDefinitionVersion !== approval.toolDefinitionVersion
    ) throw new RuntimeHttpError(409, "approval_action_changed");

    const consumed = await consumeApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId);
    await resumeTaskAfterApproval(env.RUNTIME_DB, mateId, principal, mode, taskId, approvalId);
    const result = await performPreparedCall(env, definition, principal, mode, taskId, prepared, approvalId);
    return { ...result, approval: consumed };
  } catch (error) {
    try { await consumeApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId); }
    catch { /* A concurrently consumed Approval remains single-use. */ }
    const result = await failedExecution(env, definition, principal, mode, taskId, error, approvalId);
    return { ...result, approval: await approvalAfterFailure(env, mateId, principal, mode, approvalId) };
  }
}

async function prepareAppMcpCall(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  task: Record<string, any>,
  operation: AppMcpOperation,
  includeExecutionToken: boolean
): Promise<PreparedAppMcpCall> {
  const manifest = definition.release.manifest as WorkspaceAgentRuntimeManifest;
  const binding = (await listRuntimeAppMcpBindings(env, principal, definition)).find((candidate) => candidate.appId === operation.appId);
  if (!binding) throw new RuntimeHttpError(403, "mate_app_mcp_not_bound");
  const selected = selectedAppIds(task.context);
  if (selected !== undefined && !selected.includes(operation.appId)) throw new RuntimeHttpError(403, "mate_app_mcp_not_selected");
  if (binding.allowedToolNames && !binding.allowedToolNames.includes(operation.toolName)) {
    throw new RuntimeHttpError(403, "mate_app_mcp_tool_not_allowed");
  }

  const registered = await readRegisteredApp(env, principal, operation.appId);
  if (registered.manifest.schemaVersion !== binding.manifestVersion) {
    throw new RuntimeHttpError(409, "app_mcp_manifest_version_changed");
  }
  const tool = registered.manifest.tools.find((candidate) => candidate.name === operation.toolName);
  if (!tool) throw new RuntimeHttpError(404, "app_mcp_tool_not_registered");
  validateInput(operation.arguments, tool.inputSchema);

  const discoveryToken = await mintAppResourceToken(env, principal, registered.manifest, [
    registered.manifest.authorization.toolsEndpointScope
  ]);
  const effective = await fetchEffectiveTools(env, registered.manifest, discoveryToken);
  if (!effective.toolNames.has(tool.name)) throw new RuntimeHttpError(403, "app_mcp_tool_role_required");
  const actionDigest = await sha256Hex(stableJson({
    appId: operation.appId,
    arguments: operation.arguments,
    manifestSha256: registered.manifestSha256,
    releaseId: definition.release.id,
    toolDefinitionVersion: registered.manifest.toolDefinitionVersion,
    toolName: operation.toolName
  }));
  const token = includeExecutionToken
    ? await mintAppResourceToken(env, principal, registered.manifest, tool.requiredScopes, tool.name)
    : "";
  return {
    actionDigest: `sha256:${actionDigest}`,
    manifest: registered.manifest,
    manifestSha256: registered.manifestSha256,
    operation,
    policyVersion: effective.policyVersion,
    releaseId: definition.release.id,
    token,
    tool
  };
}

async function addExecutionToken(env: RuntimeEnv, principal: RuntimePrincipal, prepared: PreparedAppMcpCall) {
  return {
    ...prepared,
    token: await mintAppResourceToken(env, principal, prepared.manifest, prepared.tool.requiredScopes, prepared.tool.name)
  };
}

async function performPreparedCall(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string,
  prepared: PreparedAppMcpCall,
  approvalId?: string
) {
  const mateId = definition.mate.id;
  const audit = await startToolAudit(env.RUNTIME_DB, mateId, principal, mode, {
    actionDigest: prepared.actionDigest,
    appId: prepared.operation.appId,
    approvalId,
    releaseId: prepared.releaseId,
    taskId,
    toolName: prepared.operation.toolName
  });
  try {
    const output = await callRegisteredTool(env, prepared);
    const resultDigest = `sha256:${await sha256Hex(stableJson(output))}`;
    await completeToolAudit(env.RUNTIME_DB, mateId, principal, mode, audit.id, { resultDigest, status: "succeeded" });
    const task = await concludeTask(env.RUNTIME_DB, mateId, principal.userId, mode, taskId, {
      actions: [{
        actionDigest: prepared.actionDigest,
        appId: prepared.operation.appId,
        approvalId,
        resultDigest,
        status: "succeeded",
        toolName: prepared.operation.toolName,
        type: "app_mcp"
      }],
      artifacts: [],
      failures: [],
      followUps: [],
      outcome: "completed",
      pendingApprovals: [],
      summary: `已按当前用户权限完成 ${prepared.operation.appId}.${prepared.operation.toolName}。`
    });
    return { output, task };
  } catch (error) {
    const code = errorCode(error);
    await completeToolAudit(env.RUNTIME_DB, mateId, principal, mode, audit.id, { errorCode: code, status: "failed" });
    throw error;
  }
}

async function failedExecution(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  mode: RuntimeMode,
  taskId: string,
  error: unknown,
  approvalId?: string
) {
  const code = errorCode(error);
  const current = await readTask(env.RUNTIME_DB, definition.mate.id, principal, mode, taskId);
  if (["completed", "failed", "cancelled"].includes(String(current.status))) return { task: current };
  const task = await concludeTask(env.RUNTIME_DB, definition.mate.id, principal.userId, mode, taskId, {
    actions: [],
    artifacts: [],
    errorCode: code,
    failures: [{ approvalId, code }],
    followUps: ["请检查当前用户 App 权限、Mate Release 绑定与 App MCP Manifest 后重试。"],
    outcome: "failed",
    pendingApprovals: [],
    summary: `Mate 未执行 App 操作（${code}）。`
  });
  return { task };
}

async function readRegisteredApp(env: RuntimeEnv, principal: RuntimePrincipal, appId: string) {
  const token = env.MATE_RUNTIME_SERVICE_TOKEN?.trim();
  if (!token) throw new RuntimeHttpError(503, "control_plane_service_token_not_configured");
  const origin = validatedOrigin(env.APPS_CONTROL_PLANE_URL || missingConfiguration("APPS_CONTROL_PLANE_URL"), "apps_control_plane_url_invalid");
  const headers = runtimeAppHeaders(token, principal);
  const request = new Request(`${origin}/internal/runtime/app-mcp/${encodeURIComponent(appId)}`, { headers });
  const response = env.APPS_CONTROL_PLANE ? await env.APPS_CONTROL_PLANE.fetch(request) : await fetch(request);
  const raw = await response.text();
  if (!response.ok) {
    throw new RuntimeHttpError(response.status === 401 ? 502 : response.status, "app_mcp_not_accessible");
  }
  try {
    const payload = record(JSON.parse(raw));
    return {
      manifest: parseWorkspaceAppMcpManifest(payload.manifest, { appId }),
      manifestSha256: text(payload.manifestSha256)
    };
  } catch {
    throw new RuntimeHttpError(502, "app_mcp_manifest_snapshot_invalid");
  }
}

function runtimeAppHeaders(token: string, principal: RuntimePrincipal) {
  const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${token}` });
  headers.set("x-workspace-runtime-user-id", principal.userId);
  headers.set("x-workspace-runtime-org-id", principal.orgId);
  if (principal.orgSlug) headers.set("x-workspace-runtime-org-slug", principal.orgSlug);
  if (principal.email) headers.set("x-workspace-runtime-user-email", principal.email);
  if (principal.name) headers.set("x-workspace-runtime-user-name", principal.name);
  if (principal.departmentId) headers.set("x-workspace-runtime-department-id", principal.departmentId);
  if (principal.departmentPath) headers.set("x-workspace-runtime-department-path", JSON.stringify(principal.departmentPath));
  return headers;
}

async function mintAppResourceToken(
  env: RuntimeEnv,
  principal: RuntimePrincipal,
  manifest: WorkspaceAppMcpManifest,
  scopes: string[],
  toolName?: string
) {
  const serviceToken = env.MATE_AUTH_SERVICE_TOKEN?.trim();
  if (!serviceToken) throw new RuntimeHttpError(503, "mate_auth_service_token_not_configured");
  const authOrigin = validatedOrigin(env.AUTH_WORKER_URL || missingConfiguration("AUTH_WORKER_URL"), "auth_worker_url_invalid");
  const response = await serviceFetch(env.AUTH_SERVICE, new Request(`${authOrigin}/v1/resource-tokens/mint`, {
    body: JSON.stringify({
      audience: manifest.audience,
      clientId: "workspace-mate-runtime",
      mcpBrokered: false,
      principal: {
        departmentId: principal.departmentId,
        departmentPath: principal.departmentPath,
        email: principal.email,
        name: principal.name,
        orgId: principal.orgId,
        sub: principal.userId
      },
      resourceId: manifest.resourceId,
      scopes,
      toolName
    }),
    headers: { Accept: "application/json", Authorization: `Bearer ${serviceToken}`, "Content-Type": "application/json" },
    method: "POST"
  }));
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  const token = text(payload.access_token);
  if (!response.ok || !token) throw new RuntimeHttpError(response.status === 403 ? 403 : 502, "app_mcp_resource_token_mint_failed");
  return token;
}

async function fetchEffectiveTools(env: RuntimeEnv, manifest: WorkspaceAppMcpManifest, token: string) {
  const response = await appFetch(env, registeredUrl(manifest, manifest.authorization.toolsEndpoint), {
    headers: { Accept: "application/json", ...resourceTokenHeaders(manifest, token) }
  });
  const raw = await response.text();
  if (!response.ok) throw new RuntimeHttpError(response.status === 401 || response.status === 403 ? 403 : 502, "app_mcp_tools_query_failed");
  try {
    const payload = record(JSON.parse(raw));
    return {
      policyVersion: text(payload.policyVersion) || undefined,
      toolNames: new Set(array(payload.tools).map((item) => text(record(item).name)).filter(Boolean))
    };
  } catch { throw new RuntimeHttpError(502, "app_mcp_tools_response_invalid"); }
}

async function callRegisteredTool(env: RuntimeEnv, prepared: PreparedAppMcpCall) {
  if (!prepared.token) throw new RuntimeHttpError(500, "app_mcp_execution_token_missing");
  const url = new URL(registeredUrl(prepared.manifest, prepared.tool.path));
  if (prepared.tool.method === "GET") {
    for (const [key, value] of Object.entries(prepared.operation.arguments)) {
      if (["string", "number", "boolean"].includes(typeof value)) url.searchParams.set(key, String(value));
    }
  }
  const response = await appFetch(env, url.toString(), {
    body: prepared.tool.method === "GET" ? undefined : JSON.stringify(prepared.operation.arguments),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...resourceTokenHeaders(prepared.manifest, prepared.token)
    },
    method: prepared.tool.method
  });
  const raw = await response.text();
  if (!response.ok) throw new RuntimeHttpError(response.status === 401 || response.status === 403 ? 403 : 502, "app_mcp_tool_call_failed");
  try { return redactToken(raw.trim() ? JSON.parse(raw) : {}, prepared.token); }
  catch { throw new RuntimeHttpError(502, "app_mcp_tool_response_invalid"); }
}

function requestedOperation(input: Record<string, unknown>) {
  assertNoCallerAuthority(input);
  return approvalOperation(input.operation);
}

function approvalOperation(value: unknown): AppMcpOperation {
  const operation = record(value);
  const appId = text(operation.appId).trim();
  const toolName = text(operation.toolName).trim();
  const args = record(operation.arguments);
  if (!appId || !toolName) throw new RuntimeHttpError(400, "app_mcp_operation_invalid");
  assertNoCallerAuthority(args);
  return { appId, arguments: args, toolName, type: "app_mcp_tool_call" };
}

function requiresApproval(manifest: WorkspaceAgentRuntimeManifest, tool: WorkspaceAppMcpTool) {
  if (tool.readOnly) return false;
  const policy = record(record(manifest.taskPolicy).approvals);
  const levels = new Set(array(policy.writeRiskLevels).map(text));
  return tool.requiresConfirmation || levels.has(tool.riskLevel);
}

function selectedAppIds(context: unknown) {
  const selection = record(record(context).capabilitySelection);
  if (!Object.hasOwn(selection, "appIds")) return undefined;
  return array(selection.appIds).map(text).filter(Boolean);
}

function validateInput(value: Record<string, unknown>, schema: Record<string, unknown>) {
  const required = array(schema.required).map(String);
  const properties = record(schema.properties);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new RuntimeHttpError(400, "app_mcp_tool_argument_required", { argument: key });
  if (schema.additionalProperties === false) {
    const extra = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
    if (extra) throw new RuntimeHttpError(400, "app_mcp_tool_argument_unknown", { argument: extra });
  }
  for (const [key, candidate] of Object.entries(value)) {
    const property = record(properties[key]);
    const types = Array.isArray(property.type) ? property.type.map(String) : [text(property.type)].filter(Boolean);
    if (types.length && !types.some((type) => matchesType(candidate, type))) {
      throw new RuntimeHttpError(400, "app_mcp_tool_argument_type_invalid", { argument: key });
    }
    if (Array.isArray(property.enum) && !property.enum.some((item) => Object.is(item, candidate))) {
      throw new RuntimeHttpError(400, "app_mcp_tool_argument_enum_invalid", { argument: key });
    }
  }
}

function matchesType(value: unknown, type: string) {
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

function assertNoCallerAuthority(value: unknown) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) return value.forEach(assertNoCallerAuthority);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(userId|ownerUserId|orgId|scopes?|accessToken|refreshToken|authorization|cookie)$/i.test(key)) {
      throw new RuntimeHttpError(400, "caller_authority_field_forbidden", { field: key });
    }
    assertNoCallerAuthority(child);
  }
}

function registeredUrl(manifest: WorkspaceAppMcpManifest, path: string) {
  const base = new URL(manifest.baseUrl);
  const url = new URL(path, `${base.origin}/`);
  if (url.origin !== base.origin) throw new RuntimeHttpError(502, "app_mcp_tool_url_invalid");
  return url.toString();
}

function resourceTokenHeaders(manifest: WorkspaceAppMcpManifest, token: string): Record<string, string> {
  return manifest.authorization.resourceTokenHeader === "x-workspace-resource-token"
    ? { "X-Workspace-Resource-Token": token }
    : { Authorization: `Bearer ${token}` };
}

function appFetch(env: RuntimeEnv, url: string, init: RequestInit) {
  return serviceFetch(env.APP_MCP_SERVICE, new Request(url, init));
}

function serviceFetch(service: Fetcher | undefined, request: Request) {
  return service ? service.fetch(request) : fetch(request);
}

function validatedOrigin(value: string, code: string) {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error(code);
    return url.origin;
  } catch { throw new RuntimeHttpError(503, code); }
}

async function approvalAfterFailure(env: RuntimeEnv, mateId: string, principal: RuntimePrincipal, mode: RuntimeMode, approvalId: string) {
  return readApproval(env.RUNTIME_DB, mateId, principal, mode, approvalId);
}

function redactToken(value: unknown, token: string): unknown {
  if (typeof value === "string") return value.replaceAll(token, "[redacted]");
  if (Array.isArray(value)) return value.map((item) => redactToken(item, token));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactToken(child, token)]));
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256Hex(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorCode(error: unknown) { return error instanceof RuntimeHttpError ? error.code : "app_mcp_execution_failed"; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
