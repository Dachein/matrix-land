import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import { assertScope, resolvePrincipal } from "./auth.ts";
import { getMateArtifact, mateArtifactContentDisposition } from "../../../src/shared/mateArtifacts.ts";
import { FOLDER_EDIT_SCOPE_HEADER, parseRuntimeFolderEditScope } from "../../../src/shared/mateFolderEditing.ts";
import { recordAgentToolActivity } from "./activity.ts";
import { authChallengeHeaders, errorResponse, html, json, normalizeAgent, normalizePath, readJson, readString, reauthorizationDetails, resourceUrl, text } from "./http.ts";
import { isMcpCallToolResult, jsonRpcError, jsonRpcResult, mcpTextResult, mcpToolErrorResult } from "./protocol.ts";
import { callMcpTool, callPublicMcpTool, forumImageHeaderFileName, MAX_UPLOAD_BYTES, mcpTools, normalizeForumMediaMime } from "./tools.ts";
import {
  runtimeWorkspacePassToolDefinitions,
  runtimeWorkspacePassToolPolicy,
  runtimeWorkspacePassWriteRisk
} from "./runtimeWorkspacePassTools.ts";
import { HttpError, SUPPORTED_AGENTS, type Env, type Principal, type SupportedAgent } from "./types.ts";
import {
  WORKSPACE_APP_COVER_GUIDANCE,
  WORKSPACE_MCP_PROTOCOL_VERSION,
  WORKSPACE_MCP_SUPPORTED_PROTOCOL_VERSIONS,
  WORKSPACE_MCP_VERSION
} from "../../../src/shared/mcpHandbook.ts";
import { directMcpInstallPrompt, type McpInstallAgent } from "../../../src/shared/mcpInstallPrompt.ts";
import { WORKSPACE_PASS_MCP_MINIMUM_CLI_VERSION, WORKSPACE_AI_CLI_VERSION } from "../../../src/shared/workspaceProductFamily.ts";
import { appsDeployArtifactPath, appsSourceSnapshotPath, proxyAppsDeployArtifactRequest, proxyAppsSourceSnapshotRequest, resolveAppsSourceSnapshotPrincipal } from "./sourceSnapshots.ts";

type JsonRpcRequest = {
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

export async function handleWorkspaceMcpWorkerRequest(
  request: Request,
  env: Env,
  executionContext?: Pick<ExecutionContext, "waitUntil">
): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: authChallengeHeaders(env, request) });
  }

  try {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    const artifactMatch = path.match(/^\/artifacts\/([^/]+)\/([^/]+)\/([^/]+)\/(art_[0-9a-f-]{36})$/);
    if (request.method === "GET" && artifactMatch) {
      if (!env.MATE_ARTIFACTS) throw new HttpError(503, "mate_artifact_storage_not_configured");
      let owner;
      try {
        owner = { orgId: decodeURIComponent(artifactMatch[1]!), userId: decodeURIComponent(artifactMatch[2]!), mateId: decodeURIComponent(artifactMatch[3]!) };
      } catch {
        throw new HttpError(400, "mate_artifact_owner_invalid");
      }
      const object = await getMateArtifact(env.MATE_ARTIFACTS, owner, artifactMatch[4]!);
      if (!object || !sameToken(url.searchParams.get("token") || "", object.customMetadata?.previewToken || "")) {
        throw new HttpError(404, "mate_artifact_not_found");
      }
      return new Response(object.body, {
        headers: {
          "Cache-Control": "private, max-age=300",
          "Content-Disposition": mateArtifactContentDisposition(object, "inline"),
          "Content-Length": String(object.size),
          "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

    if (request.method === "GET" && path === "/health") {
      return json({
        ok: true,
        service: "workspace-mcp-worker",
        capabilities: ["apps-source-snapshots-v1", "apps-deploy-artifacts-v1", "apps-source-history-v2"],
        appsWorkerUrl: env.APPS_WORKER_URL ?? null,
        requestId
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "GET" && path === "/start") {
      return html(startPage(request, env));
    }

    if (request.method === "GET" && path === "/llms.txt") {
      return text(llmsTxt(request, env, url.searchParams.get("for"), url.searchParams.get("lang")));
    }

    if (request.method === "GET" && path === "/.well-known/workspace-mcp") {
      return json(workspaceMcpMetadata(request, env));
    }

    if (request.method === "GET" && path === "/.well-known/oauth-protected-resource") {
      return json(oauthProtectedResourceMetadata(request, env));
    }

    if (request.method === "POST" && path === "/mcp") {
      return await handleMcpRequest(request, env, requestId, executionContext);
    }

    if (request.method === "GET" && path === "/internal/runtime/workspace-pass/tools") {
      assertRuntimeServiceRequest(request, env);
      const principal = runtimeWorkspacePassPrincipal(request);
      return json({
        catalogVersion: WORKSPACE_MCP_VERSION,
        domains: ["apps", "knowledge"],
        tools: runtimeWorkspacePassToolDefinitions(await mcpTools(env, principal))
      }, { headers: { "Cache-Control": "private, no-store" } });
    }

    const runtimeAiMatch = path.match(/^\/internal\/runtime\/ai\/tools\/([^/]+)$/);
    if (request.method === "POST" && runtimeAiMatch) {
      assertRuntimeServiceRequest(request, env);
      const name = decodeURIComponent(runtimeAiMatch[1]!);
      if (!["tools_image_generation", "tools_video_generation", "tools_audio_tts"].includes(name)) {
        throw new HttpError(404, "runtime_ai_tool_not_allowed");
      }
      const principal = runtimePrincipal(request, []);
      const mateId = request.headers.get("x-workspace-runtime-mate-id")?.trim() || "";
      if (!/^[A-Za-z0-9_.-]{1,180}$/.test(mateId)) throw new HttpError(400, "runtime_mate_id_invalid");
      principal.mateId = mateId;
      const input = await readJson<Record<string, unknown>>(request);
      assertNoRuntimeAuthorityFields(input);
      return json(await callPublicMcpTool(name, input, env, principal, requestId, executionContext));
    }

    const internalWorkspacePassToolMatch = path.match(/^\/internal\/runtime\/workspace-pass\/tools\/([^/]+)$/);
    if (request.method === "POST" && internalWorkspacePassToolMatch?.[1]) {
      assertRuntimeServiceRequest(request, env);
      const name = decodeURIComponent(internalWorkspacePassToolMatch[1]);
      if (!runtimeWorkspacePassToolPolicy(name)) throw new HttpError(404, "runtime_workspace_pass_tool_not_allowed");
      const input = await readJson<Record<string, unknown>>(request);
      assertNoRuntimeAuthorityFields(input);
      const writeRisk = runtimeWorkspacePassWriteRisk(name, input);
      if (writeRisk && request.headers.get("x-workspace-runtime-approval") !== "single-use-approved") {
        throw new HttpError(403, "runtime_workspace_pass_approval_required");
      }
      const result = await callPublicMcpTool(
        name,
        input,
        env,
        runtimeWorkspacePassPrincipal(request),
        requestId,
        executionContext
      );
      return json(result, { headers: { "Cache-Control": "private, no-store" } });
    }

    if (request.method === "GET" && path === "/internal/runtime/forum/topics") {
      assertRuntimeServiceRequest(request, env);
      const principal = runtimeForumPrincipal(request, false);
      const result = await callMcpTool("forum_search_topics", {
        categorySlug: url.searchParams.get("categorySlug") || undefined,
        limit: url.searchParams.get("limit") || "20",
        q: url.searchParams.get("q") || undefined,
        updatedAfter: url.searchParams.get("updatedAfter") || undefined
      }, env, principal, requestId, executionContext);
      return json(result, { headers: { "Cache-Control": "private, no-store" } });
    }

    if (request.method === "POST" && path === "/internal/runtime/forum/topics") {
      assertRuntimeServiceRequest(request, env);
      const principal = runtimeForumPrincipal(request, true);
      const input = await readJson<Record<string, unknown>>(request);
      const result = await callMcpTool("forum_create_topic", input, env, principal, requestId, executionContext);
      return json(result, { status: 201, headers: { "Cache-Control": "private, no-store" } });
    }

    const internalForumTopicMatch = path.match(/^\/internal\/runtime\/forum\/topics\/([^/]+)$/);
    if (request.method === "GET" && internalForumTopicMatch?.[1]) {
      assertRuntimeServiceRequest(request, env);
      const principal = runtimeForumPrincipal(request, false);
      const result = await callMcpTool("forum_get_topic", {
        topicId: decodeURIComponent(internalForumTopicMatch[1])
      }, env, principal, requestId, executionContext);
      return json(result, { headers: { "Cache-Control": "private, no-store" } });
    }

    const internalKnowledgeToolMatch = path.match(/^\/internal\/runtime\/knowledge\/tools\/([^/]+)$/);
    if (request.method === "POST" && internalKnowledgeToolMatch?.[1]) {
      assertRuntimeServiceRequest(request, env);
      const name = decodeURIComponent(internalKnowledgeToolMatch[1]);
      if (!RUNTIME_KNOWLEDGE_TOOLS.has(name)) throw new HttpError(404, "runtime_knowledge_tool_not_allowed");
      const principal = runtimePrincipal(request, ["workspace:knowledge:read", "workspace:knowledge:write"]);
      try {
        principal.folderEditScope = parseRuntimeFolderEditScope(request.headers.get(FOLDER_EDIT_SCOPE_HEADER) ?? "[]");
      } catch {
        throw new HttpError(403, "folder_edit_scope_required");
      }
      if (name === "knowledge_service_update") throw new HttpError(403, "folder_edit_content_only");
      const input = await readJson<Record<string, unknown>>(request);
      if (name === "knowledge_query" && (!["search", "grep"].includes(readString(input.action))
        || !readString(input.folderObjectId).trim() || readString(input.serviceId).trim())) {
        throw new HttpError(403, "folder_edit_content_only");
      }
      const result = name === "knowledge_list"
        ? await callMcpTool("knowledge_edit_list", input, env, principal, requestId, executionContext)
        : await callPublicMcpTool(name, input, env, principal, requestId, executionContext);
      return json(maintenanceKnowledgeResult(name, result), {
        headers: { "Cache-Control": "private, no-store" }
      });
    }

    const snapshotDownloadMatch = path.match(/^\/api\/apps\/apps\/([^/]+)\/source-snapshots\/([^/]+)\/download$/);
    if (request.method === "GET" && snapshotDownloadMatch?.[1] && snapshotDownloadMatch[2]) {
      const appId = decodeURIComponent(snapshotDownloadMatch[1]);
      const principal = await resolveAppsSourceSnapshotPrincipal(request, env, appId);
      assertScope(principal, ["workspace:apps:read"]);
      return proxyAppsSourceSnapshotRequest(
        request,
        env,
        principal,
        appsSourceSnapshotPath(appId, decodeURIComponent(snapshotDownloadMatch[2]))
      );
    }

    const snapshotMatch = path.match(/^\/api\/apps\/apps\/([^/]+)\/source-snapshots$/);
    if ((request.method === "GET" || request.method === "POST") && snapshotMatch?.[1]) {
      const appId = decodeURIComponent(snapshotMatch[1]);
      const principal = await resolveAppsSourceSnapshotPrincipal(request, env, appId);
      assertScope(principal, [request.method === "POST" ? "workspace:apps:write" : "workspace:apps:read"]);
      const downstreamPath = appsSourceSnapshotPath(appId);
      const downstreamUrl = new URL(request.url);
      const version = downstreamUrl.searchParams.get("version");
      return proxyAppsSourceSnapshotRequest(
        request,
        env,
        principal,
        version ? `${downstreamPath}?version=${encodeURIComponent(version)}` : downstreamPath
      );
    }

    const deployArtifactDownloadMatch = path.match(/^\/api\/apps\/apps\/([^/]+)\/deploy-artifacts\/([^/]+)\/download$/);
    if (request.method === "GET" && deployArtifactDownloadMatch?.[1] && deployArtifactDownloadMatch[2]) {
      const appId = decodeURIComponent(deployArtifactDownloadMatch[1]);
      const principal = await resolveAppsSourceSnapshotPrincipal(request, env, appId);
      assertScope(principal, ["workspace:apps:read"]);
      return proxyAppsDeployArtifactRequest(
        request,
        env,
        principal,
        appsDeployArtifactPath(appId, decodeURIComponent(deployArtifactDownloadMatch[2]))
      );
    }

    const deployArtifactMatch = path.match(/^\/api\/apps\/apps\/([^/]+)\/deploy-artifacts$/);
    if ((request.method === "GET" || request.method === "POST") && deployArtifactMatch?.[1]) {
      const appId = decodeURIComponent(deployArtifactMatch[1]);
      const principal = await resolveAppsSourceSnapshotPrincipal(request, env, appId);
      assertScope(principal, [request.method === "POST" ? "workspace:apps:write" : "workspace:apps:read"]);
      const downstreamPath = appsDeployArtifactPath(appId);
      const downstreamUrl = new URL(request.url);
      const version = downstreamUrl.searchParams.get("version");
      return proxyAppsDeployArtifactRequest(
        request,
        env,
        principal,
        version ? `${downstreamPath}?version=${encodeURIComponent(version)}` : downstreamPath
      );
    }

    if (request.method === "PUT" && path.startsWith("/api/media-upload/")) {
      return await handleMediaUpload(request, env, path.slice("/api/media-upload/".length));
    }

    return json({ error: "not_found", path, requestId }, { status: 404 });
  } catch (error) {
    return errorResponse(error, requestId, env, request);
  }
}

function assertRuntimeServiceRequest(request: Request, env: Env) {
  const expected = env.MATE_RUNTIME_SERVICE_TOKEN?.trim();
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  if (!expected) throw new HttpError(503, "mate_runtime_service_token_not_configured");
  if (!provided || provided.length !== expected.length) throw new HttpError(401, "invalid_mate_runtime_service_token");
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  if (mismatch !== 0) throw new HttpError(401, "invalid_mate_runtime_service_token");
}

const RUNTIME_KNOWLEDGE_TOOLS = new Set([
  "knowledge_list",
  "knowledge_query",
  "knowledge_file_read",
  "knowledge_file_versions",
  "knowledge_library_write",
  "knowledge_library_delete",
  "knowledge_service_update"
]);

function runtimeForumPrincipal(request: Request, write: boolean): Principal {
  return runtimePrincipal(request, write ? ["workspace:forum:write"] : ["workspace:forum:read"]);
}

function runtimeWorkspacePassPrincipal(request: Request): Principal {
  const principal = runtimePrincipal(request, [
    "workspace:mail:read", "workspace:mail:write", "workspace:mail:send",
    "workspace:forum:read",
    "workspace:forum:write",
    "workspace:hub:read",
    "workspace:market:read",
    "workspace:knowledge:read",
    "workspace:knowledge:write",
    "workspace:knowledge:share"
  ]);
  const mateId = request.headers.get("x-workspace-runtime-mate-id")?.trim();
  if (mateId) {
    if (!/^[A-Za-z0-9_.-]{1,180}$/.test(mateId)) throw new HttpError(400, "runtime_mate_id_invalid");
    principal.mateId = mateId;
  }
  return principal;
}

function assertNoRuntimeAuthorityFields(value: unknown) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(assertNoRuntimeAuthorityFields);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(userId|ownerUserId|orgId|mateId|scopes?|accessToken|refreshToken|authorization|cookie)$/i.test(key)) {
      throw new HttpError(400, "runtime_authority_field_forbidden");
    }
    assertNoRuntimeAuthorityFields(child);
  }
}

function sameToken(provided: string, expected: string) {
  if (!provided || provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  return mismatch === 0;
}

function runtimePrincipal(request: Request, scopes: string[]): Principal {
  const sub = request.headers.get("x-workspace-runtime-user-id")?.trim() || "";
  const orgId = request.headers.get("x-workspace-runtime-org-id")?.trim() || "";
  if (!sub || !orgId) throw new HttpError(400, "runtime_user_context_required");
  return {
    agentType: "codex",
    authenticatedAt: new Date().toISOString(),
    clientId: "workspace-mate-runtime",
    runtimeService: true,
    runtimeAuthServiceToken: request.headers.get("x-workspace-runtime-auth-service-token")?.trim() || undefined,
    departmentId: request.headers.get("x-workspace-runtime-department-id")?.trim() || undefined,
    departmentPath: runtimeHeaderList(request.headers.get("x-workspace-runtime-department-path")),
    email: request.headers.get("x-workspace-runtime-user-email")?.trim() || undefined,
    name: request.headers.get("x-workspace-runtime-user-name")?.trim() || undefined,
    orgId,
    role: request.headers.get("x-workspace-runtime-user-role")?.trim() || "member",
    scopes,
    sub
  };
}

function maintenanceKnowledgeResult(name: string, value: unknown) {
  if (!["knowledge_list", "knowledge_file_read", "knowledge_file_versions"].includes(name)) return value;
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (name === "knowledge_list") {
    const items = Array.isArray(payload.items) ? payload.items.filter(isEditableKnowledgeItem) : [];
    const { services: _services, ...listing } = payload;
    return { ...listing, items };
  }
  if (!isEditableKnowledgeItem(payload.item)) {
    throw new HttpError(403, "knowledge_maintenance_edit_access_required");
  }
  return payload;
}

function isEditableKnowledgeItem(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const capabilities = item.capabilities && typeof item.capabilities === "object" && !Array.isArray(item.capabilities)
    ? item.capabilities as Record<string, unknown>
    : {};
  return capabilities.canEdit === true || item.effectiveRole === "owner" || item.effectiveRole === "collaborator";
}

function runtimeHeaderList(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

async function handleMediaUpload(request: Request, env: Env, rawUploadId: string) {
  const uploadId = decodeURIComponent(rawUploadId);
  if (!uploadId) {
    return json({ error: "missing_upload_id" }, { status: 400 });
  }

  const ticket = await env.DB.prepare(
    `SELECT r2_key, file_name, mime_type, expires_at, status, owner_user_id
     FROM media_upload_sessions WHERE upload_id = ?`
  ).bind(uploadId).first<{ r2_key: string; file_name: string; mime_type: string; expires_at: number; status: string; owner_user_id: string | null }>();
  if (!ticket) {
    return json({ error: "upload_session_not_found" }, { status: 404 });
  }
  if (ticket.status !== "pending") {
    return json({ error: "upload_already_finalized" }, { status: 409 });
  }
  if (Number(ticket.expires_at) < Date.now()) {
    return json({ error: "upload_session_expired" }, { status: 410 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_UPLOAD_BYTES) {
    return json({ error: "upload_too_large" }, { status: 413 });
  }

  const bucket = env.FORUM_MEDIA;
  if (!bucket) {
    return json({ error: "forum_media_not_configured" }, { status: 503 });
  }

  const mimeType = normalizeForumMediaMime(ticket.mime_type);
  const isImage = mimeType.startsWith("image/");
  await bucket.put(ticket.r2_key, request.body ?? new Uint8Array(), {
    httpMetadata: {
      contentType: mimeType,
      contentDisposition: `${isImage ? "inline" : "attachment"}; filename="${forumImageHeaderFileName(ticket.file_name)}"`
    },
    customMetadata: {
      ownerUserId: ticket.owner_user_id ?? "",
      originalFileName: ticket.file_name,
      uploadedVia: "workspace-mcp"
    }
  });

  const object = await bucket.get(ticket.r2_key);
  if (!object || object.size <= 0 || object.size > MAX_UPLOAD_BYTES) {
    await bucket.delete(ticket.r2_key).catch(() => undefined);
    const error = object && object.size > MAX_UPLOAD_BYTES ? "upload_too_large" : "empty_upload";
    return json({ error }, { status: 400 });
  }

  return json({ ok: true, r2Key: ticket.r2_key, size: object.size, mimeType });
}

async function handleMcpRequest(
  request: Request,
  env: Env,
  requestId: string,
  executionContext?: Pick<ExecutionContext, "waitUntil">
) {
  let rpc: JsonRpcRequest;
  try {
    rpc = await readJson<JsonRpcRequest>(request);
  } catch {
    throw new HttpError(400, "invalid_json_rpc");
  }

  const id = rpc.id ?? null;
  const method = readString(rpc.method);

  let principal: Principal;
  try {
    principal = await resolvePrincipal(request, env);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      return json(jsonRpcError(id, -32001, error.code, reauthorizationDetails(error.code, env, request)), {
        status: 401,
        headers: authChallengeHeaders(env, request, error.code)
      });
    }
    throw error;
  }

  try {
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (method === "initialize") {
      const params = toRecord(rpc.params);
      const requestedProtocolVersion = readString(params.protocolVersion);
      const negotiatedProtocolVersion = WORKSPACE_MCP_SUPPORTED_PROTOCOL_VERSIONS.find(
        (version) => version === requestedProtocolVersion
      ) ?? WORKSPACE_MCP_PROTOCOL_VERSION;
      const compatibility = workspaceCliCompatibility(request, principal);
      return json(jsonRpcResult(id, {
        protocolVersion: negotiatedProtocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: "workspace-pass",
          version: WORKSPACE_MCP_VERSION
        },
        workspaceCompatibility: compatibility,
        instructions: [
          compatibility.upgradeRequired ? `Upgrade Workspace CLI before tool calls: ${compatibility.upgradeCommand}` : "Workspace CLI is compatible with this Workspace MCP release.",
          "Call ping_who_am_i first after setup and whenever connection, authentication, CLI upgrade or reinstall, or guided usage behaves unexpectedly. Use its status, checks, and requiredAction fields before trying another Workspace MCP tool.",
          "Workspace MCP is the connector for online Workspace resources. Its compact tools use an action parameter for related operations; old first-level tool names are not public aliases.",
          "Use tools_image_generation, tools_video_generation, tools_web_search, tools_web_reader, tools_audio_asr, tools_audio_tts, and tools_jev as independent public capabilities. They do not route through LiteLLM and do not appear in models_list.",
          "Use Workspace MCP by default for online Workspace resources, status, publication, and rollback. MCP cannot read the Agent's local workspace. Use frontier-workspace apps snapshot upload for a source-only backup event. For local deployment, run the project build and then use frontier-workspace apps deploy with a version number, version name, and upgrade notes; source backup is the default and --skip-source is allowed only when the user explicitly asks to omit it. Use frontier-workspace apps d1 migrate plan/apply for a local APPS App migration directory. Do not simulate local filesystem access through MCP and do not automatically publish a ready deployment.",
          WORKSPACE_APP_COVER_GUIDANCE,
          "Call knowledge_list first to see Knowledge folders readable by the current user. Use knowledge_query(action=search|grep, folderObjectId=...) for ordinary text search, knowledge_file_read(objectId=...) to read a file, and knowledge_service_handbook(serviceId=...) when a serviceId is present. Recheck permissions on every call.",
          "When the client can supply queryContext, preserve the original client session and turn, then reuse the queryId returned by the first Knowledge query step.",
          "If the authorized knowledge is missing, conflicting, or appears stale, ask the user before calling knowledge_feedback_submit. Do not copy an entire conversation into feedback.",
          "Knowledge folders are online resources and do not need Skill installation. An enabled Knowledge Service adds Handbook guidance and indexed retrieval; ordinary list, read, search, and grep use the current user's folder ACL.",
          "Use knowledge_list to browse authorized folders, knowledge_file_read to read a file, and knowledge_file_versions to inspect its history. Use knowledge_library_write only for authorized changes after approval, and knowledge_share only for explicit file-link requests.",
          "Knowledge Service activation, access management, handbook editing, and indexing are managed manually in the Frontier Workspace Portal."
        ].join(" ")
      }));
    }

    if (method === "ping") {
      return json(jsonRpcResult(id, {}));
    }

    if (method === "tools/list") {
      return json(jsonRpcResult(id, { tools: await mcpTools(env, principal) }));
    }

    if (method === "tools/call") {
      const params = toRecord(rpc.params);
      const name = readString(params.name);
      const args = toRecord(params.arguments);
      const startedAt = Date.now();
      try {
        const compatibility = workspaceCliCompatibility(request, principal);
        if (compatibility.upgradeRequired && name !== "ping_who_am_i") {
          throw new HttpError(426, "workspace_cli_upgrade_required", `Run ${compatibility.upgradeCommand}, then reload the connector.`);
        }
        const publicResult = await callPublicMcpTool(name, args, env, principal, requestId, executionContext);
        const result = name === "ping_who_am_i" && isRecord(publicResult)
          ? workspacePassStatusResult(publicResult, compatibility)
          : publicResult;
        const toolResult = isMcpCallToolResult(result) ? result : mcpTextResult(result);
        await recordAgentToolActivity(env, {
          args,
          durationMs: Date.now() - startedAt,
          principal,
          requestId,
          result,
          rpcId: id,
          status: toolResult.isError ? "blocked" : "succeeded",
          toolName: name
        }, executionContext);
        return json(jsonRpcResult(id, toolResult));
      } catch (error) {
        if (error instanceof HttpError && error.code === "unknown_mcp_tool") {
          return json(jsonRpcError(id, -32602, error.code));
        }
        const toolResult = mcpToolErrorResult({
          code: error instanceof HttpError ? error.code : "mcp_tool_error",
          message: error instanceof Error ? error.message : undefined,
          operation: name,
          requestId,
          status: error instanceof HttpError ? error.status : 500
        });
        await recordAgentToolActivity(env, {
          args,
          durationMs: Date.now() - startedAt,
          error,
          principal,
          requestId,
          rpcId: id,
          status: "blocked",
          toolName: name
        }, executionContext);
        return json(jsonRpcResult(id, toolResult));
      }
    }

    return json(jsonRpcError(id, -32601, "Method not found"));
  } catch (error) {
    if (error instanceof HttpError) {
      const message = error.message && error.message !== error.code
        ? `${error.code}: ${error.message}`
        : error.code;
      return json(jsonRpcError(id, error.status === 403 ? -32003 : -32001, message));
    }

    const message = error instanceof Error ? error.message : "mcp_tool_error";
    return json(jsonRpcError(id, -32000, message));
  }
}

function workspaceMcpMetadata(request: Request, env: Env) {
  const resource = resourceUrl(request, env);
  const agents = supportedAgents(env).map((agent) => ({
    id: publicAgentId(agent),
    label: agentLabel(agent),
    installPrompt: directMcpInstallPrompt(publicAgentId(agent), "en", resource),
    llmsTxt: `${resource}/llms.txt?for=${publicAgentId(agent)}`
  }));
  return {
    name: "Workspace MCP",
    connectorId: "workspace-pass",
    resource,
    mcpEndpoint: `${resource}/mcp`,
    installGuide: `${resource}/start`,
    llmsTxt: `${resource}/llms.txt`,
    auth: {
      authorizationServer: (env.AUTH_ISSUER?.trim() || missingConfiguration("AUTH_ISSUER")).replace(/\/+$/, ""),
      mode: "oauth_authorization_code_pkce",
      protectedResourceMetadata: `${resource}/.well-known/oauth-protected-resource`
    },
    agents,
    supportedAgents: agents.map((agent) => agent.id),
    excludedAreas: ["my-access"],
    domains: ["forum", "hub", "apps", "knowledge"]
  };
}

function oauthProtectedResourceMetadata(request: Request, env: Env) {
  const resource = resourceUrl(request, env);
  return {
    resource,
    authorization_servers: [(env.AUTH_ISSUER?.trim() || missingConfiguration("AUTH_ISSUER")).replace(/\/+$/, "")],
    bearer_methods_supported: ["header"],
    scopes_supported: [
      "workspace:mail:read", "workspace:mail:write", "workspace:mail:send",
      "workspace:forum:read",
      "workspace:forum:write",
      "workspace:hub:read",
      "workspace:apps:read",
      "workspace:apps:write",
      "workspace:knowledge:read",
      "workspace:knowledge:write",
      "workspace:knowledge:share"
    ],
    resource_documentation: `${resource}/start`
  };
}

function llmsTxt(request: Request, env: Env, rawAgent: string | null, rawLanguage: string | null) {
  const resource = resourceUrl(request, env);
  const configuredAgents = supportedAgents(env);
  const requestedAgent = normalizeInstallAgent(rawAgent);
  const requestedInternalAgent = requestedAgent ? internalAgentForInstallAgent(requestedAgent) : undefined;
  const fallbackAgent = publicAgentId(configuredAgents[0] ?? "codex");
  const agent = requestedAgent && requestedInternalAgent && configuredAgents.includes(requestedInternalAgent)
    ? requestedAgent
    : fallbackAgent;
  const language = normalizePromptLanguage(rawLanguage);

  return directMcpInstallPrompt(agent, language === "zh-CN" ? "zh" : "en", resource);
}

type PromptLanguage = "en" | "zh-CN";

function normalizePromptLanguage(value: string | null): PromptLanguage {
  return value?.trim().toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function normalizeInstallAgent(value: unknown): McpInstallAgent | undefined {
  const agent = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  return agent === "workbuddy" || agent === "claude-code" || agent === "codex" || agent === "cursor"
    ? agent
    : undefined;
}

function internalAgentForInstallAgent(agent: McpInstallAgent): SupportedAgent {
  return agent;
}

function publicAgentId(agent: SupportedAgent): McpInstallAgent {
  return agent;
}

function supportedAgents(env: Env): SupportedAgent[] {
  const configured = (env.MCP_SUPPORTED_AGENTS ?? "")
    .split(/[,\s]+/)
    .map((agent) => normalizeAgent(agent))
    .filter(Boolean) as SupportedAgent[];
  const filtered = configured.filter((agent, index, agents) => agents.indexOf(agent) === index);
  return filtered.length > 0 ? filtered : [...SUPPORTED_AGENTS];
}

function agentLabel(agent: SupportedAgent) {
  if (agent === "claude-code") {
    return "Claude Code";
  }

  if (agent === "workbuddy") {
    return "WorkBuddy";
  }

  if (agent === "cursor") {
    return "Cursor";
  }

  return "Codex";
}

function startPage(request: Request, env: Env) {
  const resource = resourceUrl(request, env);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Workspace MCP</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f8fb; color: #17202a; }
    main { max-width: 960px; margin: 0 auto; padding: 48px 20px 64px; }
    h1 { font-size: 42px; line-height: 1.05; margin: 0 0 12px; letter-spacing: 0; }
    h2 { font-size: 22px; margin: 32px 0 12px; }
    p { color: #4b5565; line-height: 1.65; }
    code, pre { font-family: "SFMono-Regular", Consolas, monospace; }
    pre { background: #101828; color: #eef4ff; padding: 16px; overflow: auto; border-radius: 8px; }
	    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
    .card { background: white; border: 1px solid #d8deea; border-radius: 8px; padding: 18px; }
    .card strong { display: block; margin-bottom: 8px; }
    .muted { color: #667085; font-size: 14px; }
    @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } h1 { font-size: 34px; } }
  </style>
</head>
<body>
  <main>
    <p class="muted">Workspace MCP · Connector</p>
	    <h1>Connect any supported Agent with one Workspace CLI installation.</h1>
    <p>Workspace MCP connects Agents to Forum, Hub, Knowledge, and APPS through enterprise authorization. My Access, personal API keys, and personal token controls are intentionally excluded.</p>

    <div class="grid">
	      <section class="card"><strong>WorkBuddy</strong><span class="muted">Workspace CLI OAuth + local stdio MCP.</span></section>
	      <section class="card"><strong>Claude Code</strong><span class="muted">Workspace CLI OAuth + user-level stdio MCP.</span></section>
	      <section class="card"><strong>Codex</strong><span class="muted">Workspace CLI OAuth + local stdio MCP.</span></section>
	      <section class="card"><strong>Cursor</strong><span class="muted">Workspace CLI OAuth + user-level stdio MCP.</span></section>
    </div>

    <h2>Install</h2>
    <p>Open Frontier Workspace Portal → MCP settings, select your Agent, and copy the one-command Workspace CLI installer. It authenticates and configures the local stdio bridge; no native MCP login or manual config edit is required.</p>

    <h2>OAuth</h2>
    <p>Workspace CLI uses OAuth Authorization Code + PKCE and automatically refreshes the private credential shared by MCP and local Workspace operations. Static Bearer headers and device login are not supported.</p>
    <pre>Authorization server: ${(env.AUTH_ISSUER?.trim() || missingConfiguration("AUTH_ISSUER")).replace(/\/+$/, "")}
Protected resource:   ${resource}/.well-known/oauth-protected-resource</pre>

    <h2>Discovery</h2>
    <pre>${resource}/.well-known/workspace-mcp
${resource}/.well-known/oauth-protected-resource</pre>
  </main>
</body>
</html>`;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function workspaceCliCompatibility(request: Request, principal: Principal) {
  const userAgent = request.headers.get("user-agent") ?? "";
  const version = userAgent.match(/(?:^|\s)workspace-cli\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ?? null;
  const upgradeRequired = version !== null && compareSemver(version, WORKSPACE_PASS_MCP_MINIMUM_CLI_VERSION) < 0;
  const agent = principal.agentType ?? "workbuddy";
  return {
    client: version ? "workspace-cli" : "unknown",
    currentVersion: version,
    minimumVersion: WORKSPACE_PASS_MCP_MINIMUM_CLI_VERSION,
    recommendedVersion: WORKSPACE_PASS_MCP_MINIMUM_CLI_VERSION,
    upgradeRequired,
    upgradeCommand: `npm install -g ./frontier-workspace-cli-${WORKSPACE_AI_CLI_VERSION}.tgz`
  };
}

function workspacePassStatusResult(
  result: Record<string, unknown>,
  compatibility: ReturnType<typeof workspaceCliCompatibility>
) {
  const connectorReady = compatibility.client === "workspace-cli";
  const status = compatibility.upgradeRequired
    ? "action_required"
    : connectorReady
      ? "ready"
      : "attention_required";
  const requiredAction = compatibility.upgradeRequired
    ? {
        type: "upgrade_cli_and_reinstall_connector",
        blocking: true,
        command: compatibility.upgradeCommand,
        then: "reload_connector_and_call_ping_who_am_i"
      }
    : !connectorReady
      ? {
          type: "reinstall_connector",
          blocking: false,
          command: compatibility.upgradeCommand,
          then: "reload_connector_and_call_ping_who_am_i"
        }
      : null;

  return {
    ...result,
    status,
    checks: {
      authentication: { status: "ok" },
      server: { status: "ok", version: WORKSPACE_MCP_VERSION },
      protocol: { status: "ok", preferredVersion: WORKSPACE_MCP_PROTOCOL_VERSION },
      connector: {
        status: connectorReady ? "ok" : "reinstall_recommended",
        client: compatibility.client
      },
      cli: {
        status: compatibility.upgradeRequired
          ? "upgrade_required"
          : compatibility.currentVersion
            ? "ok"
            : "unverified",
        currentVersion: compatibility.currentVersion,
        minimumVersion: compatibility.minimumVersion
      }
    },
    requiredAction,
    cliCompatibility: compatibility
  };
}

function compareSemver(left: string, right: string) {
  const leftParts = left.split("-", 1)[0].split(".").map(Number);
  const rightParts = right.split("-", 1)[0].split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
