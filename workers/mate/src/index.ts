import { routeMailTrigger } from "./mailTrigger.ts";
import { routeMailRequest } from "./mailRoutes.ts";
import { isWorkspaceIntrinsicBuiltInToolId } from "../../../src/shared/mate.ts";
import { requireRuntimeMode, requireRuntimeScope, resolveRuntimePrincipal } from "./auth.ts";
import { decideAndExecuteApproval } from "./approvalExecutor.ts";
import { routeMateChannelMessage } from "./channelRoutes.ts";
import { routeMateChatRequest } from "./chatRoutes.ts";
import { loadRuntimeDefinition } from "./controlPlane.ts";
import { deleteConversation } from "./conversationLifecycle.ts";
import { createReminder, createTodo, listReminderPage, listTodos, updateReminder, updateTodo } from "./inboxStorage.ts";
import { resolveRuntimeCapabilityProfile, runtimeCapabilityProfile, runtimeSurfaceProfile, webCapabilitySelection } from "./profile.ts";
import { clearOwnerPreviewData } from "./previewCleanup.ts";
import { bootstrapMateSchedules, runMateScheduleNow } from "./scheduler.ts";
import {
  createConversation,
  createTask,
  listApprovals,
  listConversations,
  listConversationPage,
  listTaskRuns,
  listTasks,
  readPreferences,
  readTask,
  savePreferences,
  updateConversation
} from "./storage.ts";
import { RuntimeHttpError, type RuntimeEnv, type RuntimeMode } from "./types.ts";
import { executeConfiguredTask } from "./taskExecutor.ts";
import { sendMateProactiveEmail } from "./emailDelivery.ts";
import { readWorkThread, listWorkThreads } from "./workThreads.ts";
import { readWorkThreadPage } from "./workThreadPage.ts";
import { enqueueBackgroundTask } from "./taskRunner.ts";
import { mateWebShell, type MateWebSurface } from "./web.ts";
import { isSupportedAttachment, readAgentAttachment } from "./agentTools/documents.ts";
import { HttpError as MateToolHttpError } from "./agentTools/http.ts";
import { proxyWorkspaceFile, saveMateArtifactToKnowledge, uploadWorkspaceAttachment } from "./agentTools/workspace.ts";
import { conversationToolContext, conversationToolEnv } from "./conversationAgent.ts";
import { routeMateWeixinChannel } from "./weixinChannel.ts";

export async function handleMateRuntimeRequest(request: Request, env: RuntimeEnv) {
  const requestId = request.headers.get("x-request-id")?.slice(0, 160) || crypto.randomUUID();
  try {
    const response = await route(request, env);
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);
    cors(headers);
    return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
  } catch (error) {
    const runtimeError = error instanceof RuntimeHttpError ? error : new RuntimeHttpError(500, "mate_runtime_error", {
      message: error instanceof Error ? error.message : "unknown_error"
    });
    return json({ error: runtimeError.code, requestId, ...runtimeError.details }, { status: runtimeError.status });
  }
}

async function route(request: Request, env: RuntimeEnv) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "workspace-mate-runtime", schemaVersion: "workspace.agentruntime/v1", channels: ["api", "email", "schedule", "mate_call", "web", "sdk", "weixin"] });
  }

  const triggerResponse = await routeMailTrigger(request,env);
  if(triggerResponse)return triggerResponse;

  const mailResponse = await routeMailRequest(request, env);
  if (mailResponse) return mailResponse;

  const chatResponse = await routeMateChatRequest(request, env);
  if (chatResponse) return chatResponse;
  const channelMessageResponse = await routeMateChannelMessage(request, env);
  if (channelMessageResponse) return channelMessageResponse;
  const weixinResponse = await routeMateWeixinChannel(request, env);
  if (weixinResponse) return weixinResponse;

  const scheduleBootstrapMatch = url.pathname.match(/^\/internal\/ops\/mates\/([^/]+)\/schedules\/bootstrap$/);
  const scheduleRunMatch = url.pathname.match(/^\/internal\/ops\/mates\/([^/]+)\/schedules\/([^/]+)\/run$/);
  if (scheduleBootstrapMatch || scheduleRunMatch) {
    assertOperatorRequest(request, env);
    if (request.method !== "POST") throw new RuntimeHttpError(405, "runtime_operator_method_not_allowed");
    const mateId = decodeURIComponent(scheduleBootstrapMatch?.[1] || scheduleRunMatch?.[1] || "");
    if (scheduleBootstrapMatch) return json({ reminders: await bootstrapMateSchedules(env, mateId) });
    return json(await runMateScheduleNow(env, mateId, decodeURIComponent(scheduleRunMatch?.[2] || "")));
  }

  const ownerWebMatch = url.pathname.match(/^\/owner\/mates\/([^/]+)\/test$/);
  const liveWebMatch = url.pathname.match(/^\/mates\/([^/]+)(?:\/(embed))?$/);
  const rootMateId = request.method === "GET" && url.pathname === "/"
    ? normalizedMateId(url.searchParams.get("mateId") || env.DEFAULT_MATE_ID)
    : "";
  if (request.method === "GET" && (ownerWebMatch?.[1] || liveWebMatch?.[1] || rootMateId)) {
    const webHostRedirect = mateWebHostRedirect(url, env, ownerWebMatch, liveWebMatch, rootMateId);
    if (webHostRedirect) return Response.redirect(webHostRedirect, 302);
    const principal = await resolveRuntimePrincipal(request, env);
    const mode: RuntimeMode = ownerWebMatch ? "preview" : "live";
    requireRuntimeMode(principal, mode);
    requireRuntimeScope(principal, mode === "preview" ? "mate:owner_test" : "mate:invoke");
    const mateId = decodeURIComponent(ownerWebMatch?.[1] || liveWebMatch?.[1] || rootMateId);
    const definition = await loadRuntimeDefinition(env, principal, mateId, mode);
    const surface: MateWebSurface = ownerWebMatch
      ? url.searchParams.get("surface") === "embed" ? "owner_test_embed" : "owner_test"
      : liveWebMatch?.[2] === "embed" ? "embedded" : "conversation";
    assertSurfaceEnabled(definition.release.manifest as Record<string, any>, surface);
    return new Response(mateWebShell(definition, {
      initialSelection: webCapabilitySelection(url, definition),
      mode,
      releaseId: mode === "preview" ? principal.testGrant?.releaseId : undefined,
      surface
    }), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const workspaceMatch = url.pathname.match(/^\/v1\/(owner-test\/)?mates\/([^/]+)\/workspace-(attachments|files)(?:\/([^/]+)\/(raw|download|thumbnail|knowledge))?$/);
  if (workspaceMatch?.[2]) {
    const mode: RuntimeMode = workspaceMatch[1] ? "preview" : "live";
    if (mode === "preview") throw new RuntimeHttpError(405, "owner_test_workspace_write_forbidden");
    const mateId = normalizedMateId(decodeURIComponent(workspaceMatch[2]));
    const principal = await resolveRuntimePrincipal(request, env);
    requireRuntimeMode(principal, mode);
    requireRuntimeScope(principal, "mate:invoke");
    const definition = await loadRuntimeDefinition(env, principal, mateId, mode);
    const agentEnv = conversationToolEnv(env);
    const agentContext = conversationToolContext(definition, principal);
    try {
      if (workspaceMatch[3] === "attachments" && !workspaceMatch[4]) {
        if (request.method !== "POST") throw new RuntimeHttpError(405, "runtime_method_not_allowed");
        const declaredLength = Number(request.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > 21 * 1024 * 1024) {
          throw new RuntimeHttpError(413, "workspace_attachment_too_large");
        }
        if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data;")) {
          throw new RuntimeHttpError(415, "workspace_attachment_content_type_unsupported");
        }
        const form = await request.formData();
        const uploadedFile = form.get("file");
        if (!(uploadedFile instanceof File)) throw new RuntimeHttpError(400, "workspace_attachment_missing");
        const requestedName = form.get("fileName");
        const fileName = typeof requestedName === "string" ? requestedName.trim() : "";
        if (fileName && (fileName.length > 255 || /[\\/\u0000-\u001f]/.test(fileName) || fileName === "." || fileName === "..")) {
          throw new RuntimeHttpError(400, "workspace_attachment_name_invalid");
        }
        const requestedType = form.get("mediaType");
        const mediaType = typeof requestedType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(requestedType) ? requestedType : uploadedFile.type;
        const file = fileName ? new File([uploadedFile], fileName, { type: mediaType }) : uploadedFile;
        const skillPackage = file.name.toLowerCase().endsWith(".zip");
        if (skillPackage) {
          if (principal.callerKind !== "user" || principal.userId !== definition.mate.ownerUserId
            || principal.orgId !== definition.mate.orgId) {
            throw new RuntimeHttpError(403, "mate_skill_package_owner_required");
          }
          if (file.size > 400_000) throw new RuntimeHttpError(413, "mate_skill_package_too_large");
        } else if (file.type.toLowerCase().startsWith("image/")) {
          const imageInput = definition.release.manifest.modelPolicy.multimodal?.imageInput === true;
          const imageToolBound = definition.release.manifest.resources.builtInToolBindings.some(
            (binding) => binding.toolId === "ocr" || binding.toolId === "document_read"
          );
          if (!imageInput && !imageToolBound) {
            throw new RuntimeHttpError(403, "runtime_image_input_not_enabled");
          }
        } else {
          assertBuiltInCapability(definition, "document_read");
        }
        if (!skillPackage && !isSupportedAttachment(file.name, file.type || "application/octet-stream")) {
          throw new RuntimeHttpError(415, "workspace_attachment_type_unsupported");
        }
        return json(await uploadWorkspaceAttachment(agentEnv, agentContext, file, { signal: request.signal }), { status: 201 });
      }
      if (workspaceMatch[3] === "files" && workspaceMatch[4] && workspaceMatch[5]) {
        assertAnyBuiltInCapability(definition, ["artifact_create", "document_read"]);
        const objectId = workspaceObjectId(workspaceMatch[4]);
        if (workspaceMatch[5] === "knowledge") {
          if (request.method !== "POST") throw new RuntimeHttpError(405, "runtime_method_not_allowed");
          if (!/^art_[0-9a-f-]{36}$/.test(objectId)) throw new RuntimeHttpError(400, "mate_artifact_reference_invalid");
          const input = await readJson(request) as { parentObjectId?: unknown };
          const parentObjectId = typeof input.parentObjectId === "string" ? input.parentObjectId.trim() : "";
          if (parentObjectId && !/^[A-Za-z0-9_.-]{1,180}$/.test(parentObjectId)) {
            throw new RuntimeHttpError(400, "knowledge_folder_id_invalid");
          }
          return json(await saveMateArtifactToKnowledge(agentEnv, agentContext, objectId, parentObjectId || undefined, { signal: request.signal }));
        }
        if (request.method !== "GET") throw new RuntimeHttpError(405, "runtime_method_not_allowed");
        if (workspaceMatch[5] !== "thumbnail" && url.searchParams.get("preview") === "markdown") {
          assertBuiltInCapability(definition, "document_read");
          const fileName = url.searchParams.get("fileName") || "";
          if (fileName.length > 255 || !/\.(docx|xlsx|xls|xlsb|xlsm|ods|odt|numbers)$/i.test(fileName) || /[\\/\u0000-\u001f]/.test(fileName)) {
            throw new RuntimeHttpError(400, "workspace_preview_name_invalid");
          }
          const attachment = { id: "preview", objectId, fileName, mediaType: "application/octet-stream" };
          const result = await readAgentAttachment(agentEnv, agentContext, new Map([[attachment.id, attachment]]), attachment.id, request.signal);
          return new Response(result.content + (result.truncated ? "\n\n_Preview truncated at 100,000 characters. Download the original file for full contents._" : ""), {
            headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }
          });
        }
        return await proxyWorkspaceFile(agentEnv, agentContext, objectId, workspaceMatch[5] as "download" | "raw" | "thumbnail", request);
      }
    } catch (error) {
      if (error instanceof MateToolHttpError) throw new RuntimeHttpError(error.status, error.message);
      throw error;
    }
    throw new RuntimeHttpError(404, "runtime_workspace_route_not_found");
  }

  const match = url.pathname.match(/^\/v1\/(owner-test\/)?mates\/([^/]+)(?:\/(runtime|conversations|tasks|preferences|approvals|todos|reminders|threads))?(?:\/([^/]+))?(?:\/(decision|run|runs|receipt))?$/);
  if (!match?.[2]) throw new RuntimeHttpError(404, "runtime_route_not_found");
  const mode: RuntimeMode = match[1] ? "preview" : "live";
  const mateId = decodeURIComponent(match[2]);
  const resource = match[3] || "runtime";
  const resourceId = match[4] ? decodeURIComponent(match[4]) : "";
  const action = match[5];
  const principal = await resolveRuntimePrincipal(request, env);
  requireRuntimeMode(principal, mode);
  requireRuntimeScope(principal, mode === "preview" ? "mate:owner_test" : resource === "preferences" ? "mate:preferences" : "mate:invoke");
  const definition = await loadRuntimeDefinition(env, principal, mateId, mode);

  if (request.method === "GET" && resource === "runtime" && !resourceId) {
    return json({
      mate: {
        ...definition.mate,
        ...(definition.release.manifest.mate.avatarRef ? { avatarUrl: definition.release.manifest.mate.avatarRef } : {})
      },
      release: { id: definition.release.id, version: definition.release.version, manifestSha256: definition.release.manifestSha256 },
      scope: { isolation: "mateId × userId", mode },
      capabilities: await resolveRuntimeCapabilityProfile(env, definition, principal),
      surface: runtimeSurfaceProfile(definition, mode)
    });
  }
  if (resource === "conversations" && !resourceId) {
    if (request.method === "GET") {
      if (url.searchParams.has("status")) return json(await listConversationPage(
        env.RUNTIME_DB, mateId, principal, mode, url.searchParams.get("status") || "", url.searchParams.get("cursor")
      ));
      return json({ conversations: await listConversations(env.RUNTIME_DB, mateId, principal, mode) });
    }
    if (request.method === "DELETE") {
      if (mode !== "preview") throw new RuntimeHttpError(405, "runtime_method_not_allowed");
      return json({
        cleared: await clearOwnerPreviewData(env, mateId, principal, definition.release.id)
      });
    }
    if (request.method === "POST") return json({ conversation: await createConversation(env.RUNTIME_DB, mateId, principal, mode, await readJson(request)) }, { status: 201 });
  }
  if (resource === "conversations" && resourceId && !action) {
    if (request.method === "PATCH") {
      return json({
        conversation: await updateConversation(env.RUNTIME_DB, mateId, principal, mode, resourceId, await readJson(request))
      });
    }
    if (request.method === "DELETE") {
      return json({
        conversation: await deleteConversation(env, mateId, principal, mode, resourceId, definition.release.id)
      });
    }
  }
  if (resource === "threads" && request.method === "GET" && !action) {
    const scope = {mateId,userId:principal.userId,mode};
    if (!resourceId) return json(await listWorkThreads(env.RUNTIME_DB,scope,url.searchParams.get("kind") || "task",url.searchParams.get("cursor")));
    return json({...await readWorkThreadPage(env.RUNTIME_DB,scope,resourceId,url.searchParams.get("cursor")),executionProfile:{releaseId:definition.release.id,skills:(definition.skills || []).map(skill=>({name:skill.name,version:skill.version}))}});
  }
  if (resource === "tasks") {
    if (request.method === "GET" && !resourceId) {
      return json({ tasks: await listTasks(env.RUNTIME_DB, mateId, principal, mode, url.searchParams.get("conversationId") || undefined) });
    }
    if (request.method === "POST" && !resourceId) {
      return json({ task: await createTask(env.RUNTIME_DB, definition, principal, mode, await readJson(request)) }, { status: 202 });
    }
    if (request.method === "GET" && resourceId && !action) return json({ task: await readTask(env.RUNTIME_DB, mateId, principal, mode, resourceId) });
    if (request.method === "GET" && resourceId && action === "runs") {
      return json({ runs: await listTaskRuns(env.RUNTIME_DB, mateId, principal, mode, resourceId) });
    }
    if (request.method === "POST" && resourceId && action === "receipt") {
      assertCallerIdentityNotSelected(await readJson(request));
      if(mode!=="live") throw new RuntimeHttpError(405,"preview_receipt_delivery_forbidden");
      const task=await readTask(env.RUNTIME_DB,mateId,principal,mode,resourceId);
      const conclusion=task.conclusion as {summary?:string}|undefined;
      if(!task.threadId || !conclusion?.summary) throw new RuntimeHttpError(409,"task_receipt_not_ready");
      if(!principal.email) throw new RuntimeHttpError(409,"receipt_recipient_not_configured");
      const thread=await readWorkThread(env.RUNTIME_DB,{mateId,userId:principal.userId,mode},task.threadId);
      const delivery=await sendMateProactiveEmail(env,definition,principal,{body:conclusion.summary,subject:thread.title,taskId:resourceId,threadCode:thread.threadCode,to:principal.email});
      return json({task,delivery},{status:delivery.status==="failed" ? 502 : 200});
    }
    if (request.method === "POST" && resourceId && action === "run") {
      const body = await readJson(request);
      assertCallerIdentityNotSelected(body);
      const task = await readTask(env.RUNTIME_DB, mateId, principal, mode, resourceId);
      assertTaskCanRunThroughPublicRoute(task);
      if (body.background === true) {
        if (body.operation !== undefined) throw new RuntimeHttpError(400, "background_task_operation_not_supported");
        if (task.status !== "queued") throw new RuntimeHttpError(409, "task_not_queued");
        if (task.releaseId !== definition.release.id) throw new RuntimeHttpError(409, "task_release_changed");
        await enqueueBackgroundTask(env, { mateId, taskId: resourceId, mode, principal });
        return json({ task: await readTask(env.RUNTIME_DB, mateId, principal, mode, resourceId) }, { status: 202 });
      }
      let result: Awaited<ReturnType<typeof executeConfiguredTask>>;
      try { result = await executeConfiguredTask(env, definition, principal, mode, resourceId, body); }
      catch(error) {
        if(error instanceof RuntimeHttpError && error.code==="thread_busy" && !body.operation && env.MATE_TASK_RUNNER) {
          await enqueueBackgroundTask(env,{mateId,taskId:resourceId,mode,principal});
          return json({accepted:true,task:await readTask(env.RUNTIME_DB,mateId,principal,mode,resourceId)},{status:202});
        }
        throw error;
      }
      const approval = "approval" in result ? result.approval as { status?: string } | undefined : undefined;
      return json(result, { status: approval?.status === "pending" ? 202 : 200 });
    }
  }
  if (resource === "preferences" && !resourceId) {
    if (mode === "preview") throw new RuntimeHttpError(405, "owner_test_preferences_not_persisted");
    if (request.method === "GET") return json({ preferences: await readPreferences(env.RUNTIME_DB, mateId, principal) ?? null });
    if (request.method === "PUT") return json({ preferences: await savePreferences(env.RUNTIME_DB, definition, principal, await readJson(request)) });
  }
  if (resource === "approvals") {
    if (request.method === "GET" && !resourceId) return json({ approvals: await listApprovals(env.RUNTIME_DB, mateId, principal, mode) });
    if (request.method === "POST" && resourceId && action === "decision") {
      const body = await readJson(request);
      assertCallerIdentityNotSelected(body);
      return json(await decideAndExecuteApproval(env, definition, principal, mode, resourceId, body.decision));
    }
  }
  if (resource === "todos") {
    if (mode === "preview") throw new RuntimeHttpError(405, "owner_test_inbox_data_not_persisted");
    assertBuiltInCapability(definition, "todo_manage");
    if (request.method === "GET" && !resourceId) return json({ todos: await listTodos(env.RUNTIME_DB, mateId, principal) });
    if (request.method === "POST" && !resourceId) {
      const body = await readJson(request);
      assertCallerIdentityNotSelected(body);
      return json({ todo: await createTodo(env.RUNTIME_DB, mateId, principal.userId, body) }, { status: 201 });
    }
    if (request.method === "PATCH" && resourceId) {
      const body = await readJson(request);
      assertCallerIdentityNotSelected(body);
      return json({ todo: await updateTodo(env.RUNTIME_DB, mateId, principal, resourceId, body) });
    }
  }
  if (resource === "reminders") {
    if (mode === "preview") throw new RuntimeHttpError(405, "owner_test_inbox_data_not_persisted");
    assertBuiltInCapability(definition, "reminder_manage");
    if (request.method === "GET" && !resourceId) return json(await listReminderPage(env.RUNTIME_DB,mateId,principal,url.searchParams.get("cursor")));
    if (request.method === "POST" && !resourceId) {
      const body = await readJson(request);
      assertCallerIdentityNotSelected(body);
      return json({ reminder: await createReminder(env.RUNTIME_DB, mateId, principal.userId, body) }, { status: 201 });
    }
    if (request.method === "PATCH" && resourceId) {
      const body = await readJson(request);
      assertCallerIdentityNotSelected(body);
      return json({ reminder: await updateReminder(env.RUNTIME_DB, mateId, principal, resourceId, body) });
    }
  }
  throw new RuntimeHttpError(405, "runtime_method_not_allowed");
}

function assertBuiltInCapability(definition: Awaited<ReturnType<typeof loadRuntimeDefinition>>, toolId: string) {
  if (isWorkspaceIntrinsicBuiltInToolId(toolId)) return;
  if (!definition.release.manifest.resources.builtInToolBindings.some((binding) => binding.toolId === toolId)) {
    throw new RuntimeHttpError(403, "runtime_builtin_capability_not_bound", { toolId });
  }
}

function assertAnyBuiltInCapability(definition: Awaited<ReturnType<typeof loadRuntimeDefinition>>, toolIds: string[]) {
  if (!definition.release.manifest.resources.builtInToolBindings.some((binding) => toolIds.includes(binding.toolId))) {
    throw new RuntimeHttpError(403, "runtime_builtin_capability_not_bound", { toolIds });
  }
}

function assertTaskCanRunThroughPublicRoute(task: { channel: string; instruction: string }) {
  if (task.channel === "sdk" && task.instruction.startsWith("agent-do-message:")) {
    throw new RuntimeHttpError(409, "mate_chat_task_agent_owned");
  }
}

function assertOperatorRequest(request: Request, env: RuntimeEnv) {
  const expected = env.MATE_OPERATOR_TOKEN?.trim();
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  if (!expected) throw new RuntimeHttpError(503, "mate_operator_token_not_configured");
  if (!provided || provided.length !== expected.length) throw new RuntimeHttpError(401, "invalid_mate_operator_token");
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  if (mismatch !== 0) throw new RuntimeHttpError(401, "invalid_mate_operator_token");
}

function assertSurfaceEnabled(manifest: Record<string, any>, surface: MateWebSurface) {
  const channels = manifest.channels ?? {};
  const experience = manifest.experiencePolicy ?? {};
  const enabled = surface === "embedded" ? channels.embedded?.enabled === true && experience.conversation?.enabled === true
    : surface === "conversation" ? channels.standalone?.enabled === true && experience.conversation?.enabled === true
      : experience.ownerTesting?.enabled === true;
  if (!enabled) throw new RuntimeHttpError(403, "mate_surface_disabled");
}

function normalizedMateId(value: unknown) {
  const mateId = typeof value === "string" ? value.trim() : "";
  if (!mateId) throw new RuntimeHttpError(404, "runtime_default_mate_not_configured");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(mateId)) throw new RuntimeHttpError(400, "mate_id_invalid");
  return mateId;
}

function workspaceObjectId(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    if (!/^[A-Za-z0-9_.-]{1,180}$/.test(decoded)) throw new Error();
    return decoded;
  } catch {
    throw new RuntimeHttpError(400, "workspace_file_reference_invalid");
  }
}

function mateWebHostRedirect(
  requestUrl: URL,
  env: RuntimeEnv,
  ownerWebMatch: RegExpMatchArray | null,
  liveWebMatch: RegExpMatchArray | null,
  rootMateId: string
) {
  const origin = safeWebHostOrigin(env.MATE_WEB_HOST_URL);
  if (!origin) return "";
  const mateId = normalizedMateId(decodeURIComponent(ownerWebMatch?.[1] || liveWebMatch?.[1] || rootMateId));
  const path = `/mates/${encodeURIComponent(mateId)}`;
  if (!ownerWebMatch) return `${origin}${path}${liveWebMatch?.[2] === "embed" ? "/embed" : ""}`;
  const releaseId = requestUrl.searchParams.get("release")?.trim() || "";
  if (!releaseId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(releaseId)) return "";
  const query = new URLSearchParams({ release: releaseId });
  if (requestUrl.searchParams.get("surface") === "embed") query.set("presentation", "embedded");
  if (requestUrl.searchParams.get("debug") === "1") query.set("debug", "1");
  return `${origin}${path}/preview?${query}`;
}

function safeWebHostOrigin(value: string | undefined) {
  if (!value?.trim()) return "";
  try {
    const url = new URL(value.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return "";
    return url.origin;
  } catch {
    return "";
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return {};
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { throw new RuntimeHttpError(400, "invalid_json"); }
}

function assertCallerIdentityNotSelected(input: Record<string, unknown>) {
  for (const key of Object.keys(input)) {
    if (/^(userId|ownerUserId|orgId|scopes?|accessToken|refreshToken|authorization|cookie)$/i.test(key)) {
      throw new RuntimeHttpError(400, "caller_authority_field_forbidden", { field: key });
    }
  }
}

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  cors(headers);
  return new Response(JSON.stringify(body), { ...init, headers });
}

function cors(headers: Headers) {
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "DELETE,GET,POST,PUT,PATCH,OPTIONS");
  headers.set("access-control-allow-headers", "Authorization,Content-Type,X-Workspace-User-Id,X-Workspace-Org-Id,X-Workspace-Scopes,X-Workspace-Caller-Kind");
  headers.set("access-control-expose-headers", "X-Workspace-Chat-Next-Cursor,X-Request-Id");
  headers.set("cache-control", "private, no-store");
}
