import { callMailRuntime } from "./execution/clients/mail.ts";
import { callKnowledgeWorkerJson, callKnowledgeWorkerRaw } from "./execution/clients/knowledge.ts";
import { callAppsWorker, downloadCurrentAppsSource } from "./execution/clients/apps.ts";
import { callMateRuntime } from "./execution/clients/mateRuntime.ts";
import { listForumCategories } from "./execution/forum/categories.ts";
import { beginUpload, finalizeUpload, uploadForumMedia } from "./execution/forum/media.ts";
import { getForumTopic, searchForumTopics } from "./execution/forum/reads.ts";
import { createForumReply } from "./execution/forum/replies.ts";
import { createForumTopic, updateForumTopic } from "./execution/forum/topics.ts";
import { downloadHubSkillPackage, getHubListing, searchHubListings } from "./execution/hub/reads.ts";
import { submitHubListing } from "./execution/hub/submissions.ts";
import {
  knowledgeFileFormData,
  knowledgePublicShareResult,
  knowledgeQueryContext,
  mergeKnowledgeRootListings,
  normalizeKnowledgeShareExpiry,
  requireToolConfirmation
} from "./execution/knowledge/arguments.ts";
import { bytesToBase64, isRecord, optionalText, readOptionalString, requireArg, requireText } from "./execution/values.ts";
export { normalizeForumMediaMime, forumImageHeaderFileName } from "./execution/forum/media.ts";

import { INTERNAL_MCP_COMMANDS } from "./toolDefinitions/index.ts";
export { MAX_UPLOAD_BYTES } from "./toolDefinitions/index.ts";

import { assertScope } from "./auth.ts";

import { callAppMcpTool, listAccessibleAppMcpResources, listAppMcpTools } from "./appMcpBroker.ts";

import { readString } from "./http.ts";
import { listGatewayModelCatalog } from "./llmGateway.ts";
import { callJev, generateImage, generateSpeech, generateVideo, readWeb, searchWeb, transcribeAudio } from "./publicCapabilityTools.ts";
import { type SchemaValidationIssue, validateJsonSchema } from "./schemaValidation.ts";
import { buildPublicMcpTools, publicMcpToolActions, resolvePublicToolCall } from "./publicTools.ts";
import { type Env, HttpError, type Principal } from "./types.ts";

import {
  WORKSPACE_MCP_PROTOCOL_VERSION,
  WORKSPACE_MCP_RELEASED_AT,
  WORKSPACE_MCP_SUPPORTED_PROTOCOL_VERSIONS,
  WORKSPACE_MCP_VERSION
} from "../../../src/shared/mcpHandbook.ts";

const FORUM_READ_SCOPES = ["workspace:forum:read"];
const FORUM_WRITE_SCOPES = ["workspace:forum:write"];
const HUB_READ_SCOPES = ["workspace:hub:read", "workspace:market:read"];
const HUB_SUBMIT_SCOPES = ["workspace:apps:write"];
const APPS_APP_READ_SCOPES = ["workspace:apps:read", "workspace:apps:write"];
const APPS_APP_WRITE_SCOPES = ["workspace:apps:write"];
const APPS_WRITE_SCOPES = ["workspace:apps:write"];
const APPS_SKILL_READ_SCOPES = ["workspace:apps:read", "workspace:apps:write"];
const APPS_SKILL_WRITE_SCOPES = ["workspace:apps:write"];
const APPS_MATE_READ_SCOPES = ["workspace:apps:read", "workspace:apps:write"];
const APPS_MATE_WRITE_SCOPES = ["workspace:apps:write"];
const KNOWLEDGE_READ_SCOPES = ["workspace:knowledge:read"];
const KNOWLEDGE_WRITE_SCOPES = ["workspace:knowledge:write"];
const KNOWLEDGE_SHARE_SCOPES = ["workspace:knowledge:share"];

const INTERNAL_MCP_VALIDATION_SCHEMAS = new Map(
  INTERNAL_MCP_COMMANDS.map((definition) => [definition.name, {
    ...definition.inputSchema,
    additionalProperties: definition.inputSchema.additionalProperties ?? false
  }])
);

export async function mcpTools(_env?: Env, principal?: Principal) {
  return buildPublicMcpTools(INTERNAL_MCP_COMMANDS, principal);
}

export async function callPublicMcpTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  principal: Principal,
  requestId?: string,
  executionContext?: Pick<ExecutionContext, "waitUntil">
) {
  const route = resolvePublicToolCall(name, args);
  if (!route) {
    const actions = publicMcpToolActions(name);
    if (actions.length > 0) {
      throw new HttpError(
        400,
        "invalid_mcp_tool_action",
        `Invalid or missing action for ${name}. Allowed actions: ${actions.join(", ")}.`
      );
    }
    throw new HttpError(404, "unknown_mcp_tool");
  }
  if (route.kind === "internal") {
    validateInternalMcpToolArguments(route.internalName, route.args, name, args.action);
    if (name === "knowledge_list") {
      const [rootPayload, servicePayload] = await Promise.all([
        callMcpTool("knowledge_edit_list", route.args, env, principal, requestId, executionContext),
        callMcpTool("knowledge_service_list", {}, env, principal, requestId, executionContext)
      ]);
      const roots = isRecord(rootPayload) ? rootPayload : {};
      const services = isRecord(servicePayload) ? servicePayload : {};
      return {
        ...roots,
        items: (Array.isArray(roots.items) ? roots.items : []).filter((item) => (
          isRecord(item) && isRecord(item.capabilities) && item.capabilities.canRead === true
        )),
        services: Array.isArray(services.services) ? services.services : []
      };
    }
    return callMcpTool(route.internalName, route.args, env, principal, requestId, executionContext);
  }

}

function validateInternalMcpToolArguments(
  internalName: string,
  args: Record<string, unknown>,
  publicName: string,
  action: unknown
) {
  const schema = INTERNAL_MCP_VALIDATION_SCHEMAS.get(internalName);
  if (!schema) throw new HttpError(404, "unknown_mcp_tool");
  const issues = validateJsonSchema(schema, args);
  if (issues.length === 0) return;

  const operation = typeof action === "string" ? `${publicName}.${action}` : publicName;
  const details = issues
    .slice(0, 4)
    .map(formatMcpArgumentValidationError)
    .join("; ");
  throw new HttpError(
    400,
    "invalid_mcp_tool_arguments",
    `Invalid arguments for ${operation}${details ? `: ${details}` : "."}`
  );
}

function formatMcpArgumentValidationError(error: SchemaValidationIssue) {
  const location = error.instancePath ? `arguments${error.instancePath}` : "arguments";
  if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
    return `${location} must include ${error.params.missingProperty}`;
  }
  if (error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string") {
    return `${location} does not support ${error.params.additionalProperty}`;
  }
  return `${location} ${error.message ?? "is invalid"}`;
}

// Internal command dispatcher. These command ids are intentionally not returned
// by tools/list; the public Workspace MCP surface resolves tool + action here.
export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  principal: Principal,
  requestId?: string,
  executionContext?: Pick<ExecutionContext, "waitUntil">
) {
  if (isRemovedPublicTool(name)) {
    throw new HttpError(404, "unknown_mcp_tool");
  }
  if (isRemovedKnowledgeServiceTool(name)) {
    throw removedKnowledgeServiceToolError(name);
  }
  const deprecatedToolAlias: string | undefined = undefined;

  if (name === "ping_who_am_i") {
    return {
      authenticated: true,
      authenticatedAt: normalizedUtcTimestamp(principal.authenticatedAt),
      serverTime: new Date().toISOString(),
      server: {
        name: "workspace-pass",
        version: WORKSPACE_MCP_VERSION,
        releasedAt: WORKSPACE_MCP_RELEASED_AT,
        protocolVersion: WORKSPACE_MCP_PROTOCOL_VERSION,
        supportedProtocolVersions: [...WORKSPACE_MCP_SUPPORTED_PROTOCOL_VERSIONS]
      },
      account: {
        defaultAgent: principal.defaultAgent ?? null,
        id: principal.sub,
        name: principal.name ?? null,
        email: principal.email ?? null,
        role: principal.role ?? null,
        organizationId: principal.orgId ?? null,
        team: principal.team ?? null,
        teamId: principal.teamId ?? null,
        department: principal.department ?? null,
        departmentId: principal.departmentId ?? null
      },
      connection: {
        id: principal.connectionId ?? null,
        clientId: principal.clientId ?? null,
        agentType: principal.agentType ?? null,
        authentication: "oauth"
      }
    };
  }

  if (name === "models_list") {
    return listGatewayModelCatalog(env);
  }

  if (name === "image_generation") return generateImage(env, args, principal);
  if (name === "video_generation") return generateVideo(env, args, principal);
  if (name === "web_search") return searchWeb(env, args);
  if (name === "web_reader") return readWeb(env, args);
  if (name === "whisper_asr") return transcribeAudio(env, args);
  if (name === "audio_tts") return generateSpeech(env, args, principal);
  if (name === "jev") return callJev(env, args);

  if (name === "app_mcp_accessible_list") {
    assertScope(principal, APPS_APP_READ_SCOPES);
    return listAccessibleAppMcpResources(env, principal);
  }

  if (name === "app_mcp_tools_list") {
    assertScope(principal, APPS_APP_READ_SCOPES);
    return listAppMcpTools(requireArg(args.appId, "missing_app_id"), env, principal);
  }

  if (name === "app_mcp_tool_call") {
    assertScope(principal, APPS_APP_READ_SCOPES);
    return callAppMcpTool({
      appId: requireArg(args.appId, "missing_app_id"),
      toolName: requireArg(args.toolName, "missing_app_mcp_tool_name"),
      arguments: isRecord(args.arguments) ? args.arguments : (() => { throw new HttpError(400, "invalid_app_mcp_tool_arguments"); })(),
      confirmation: args.confirmation === true,
    }, env, principal);
  }

  if (name === "forum_list_categories") {
    assertScope(principal, FORUM_READ_SCOPES);
    return { categories: await listForumCategories(env.DB) };
  }

  if (name === "forum_search_topics") {
    assertScope(principal, FORUM_READ_SCOPES);
    return { topics: await searchForumTopics(env.DB, args) };
  }

  if (name === "forum_get_topic") {
    assertScope(principal, FORUM_READ_SCOPES);
    return { topic: await getForumTopic(env.DB, requireArg(args.topicId, "missing_topic_id")) };
  }

  if (name === "forum_create_topic") {
    assertScope(principal, FORUM_WRITE_SCOPES);
    return { topic: await createForumTopic(env, args, principal, executionContext) };
  }

  if (name === "forum_update_topic") {
    assertScope(principal, FORUM_WRITE_SCOPES);
    return { topic: await updateForumTopic(env, args, principal) };
  }

  if (name === "forum_upload_media") {
    assertScope(principal, FORUM_WRITE_SCOPES);
    return { image: await uploadForumMedia(env, args, principal) };
  }

  if (name === "upload_begin") {
    assertScope(principal, FORUM_WRITE_SCOPES);
    return await beginUpload(env, args, principal);
  }

  if (name === "upload_finalize") {
    assertScope(principal, FORUM_WRITE_SCOPES);
    return await finalizeUpload(env, args, principal);
  }

  if (name === "forum_create_reply") {
    assertScope(principal, FORUM_WRITE_SCOPES);
    return await createForumReply(env, args, principal, executionContext);
  }

  if (name === "hub_search" || name === "hub_search_listings" || name === "market_search_listings") {
    assertScope(principal, HUB_READ_SCOPES);
    return { listings: await searchHubListings(env, principal, args) };
  }

  if (name === "hub_skills_list" || name === "hub_list_skills") {
    assertScope(principal, HUB_READ_SCOPES);
    return { listings: await searchHubListings(env, principal, { ...args, type: "skill" }, ["skill"]) };
  }

  if (name === "hub_list_apps") {
    assertScope(principal, HUB_READ_SCOPES);
    return { listings: await searchHubListings(env, principal, { ...args, type: "app" }, ["app"]) };
  }

  if (name === "hub_get_listing" || name === "market_get_listing") {
    assertScope(principal, HUB_READ_SCOPES);
    return { listing: await getHubListing(env, principal, requireArg(args.listingId, "missing_listing_id")) };
  }

  if (name === "hub_skill_download" || name === "hub_download_skill_package") {
    assertScope(principal, HUB_READ_SCOPES);
    return await downloadHubSkillPackage(env, principal, args);
  }

  if (name === "hub_submit_listing" || name === "hub_submit_app" || name === "hub_submit_skill") {
    assertScope(principal, HUB_SUBMIT_SCOPES);
    return await submitHubListing(env, args, principal, name);
  }

  if (name === "hub_get_skill_install_prompt") {
    assertScope(principal, HUB_READ_SCOPES);
    const downloaded = await downloadHubSkillPackage(env, principal, args);
    const downloadedRecord = downloaded as Record<string, unknown>;
    const install = downloadedRecord.install && typeof downloadedRecord.install === "object" && !Array.isArray(downloadedRecord.install)
      ? downloadedRecord.install as Record<string, unknown>
      : {};
    return { prompt: readString(install.prompt) };
  }

  if (name === "knowledge_edit_list") {
    assertScope(principal, KNOWLEDGE_READ_SCOPES);
    const query = new URLSearchParams();
    const folderObjectId = readOptionalString(args.folderObjectId);
    const legacyPrefixProvided = Object.prototype.hasOwnProperty.call(args, "prefix");
    if (folderObjectId) {
      query.set("folderObjectId", folderObjectId);
    } else if (legacyPrefixProvided) {
      query.set("prefix", readString(args.prefix));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const requestOptions = {
      scopes: ["workspace:knowledge:read"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    };
    if (!folderObjectId && !legacyPrefixProvided) {
      const [personal, shared] = await Promise.all([
        callKnowledgeWorkerJson(env, principal, "/api/tree", requestOptions),
        callKnowledgeWorkerJson(env, principal, "/api/shared-with-me", requestOptions)
      ]);
      return mergeKnowledgeRootListings(personal, shared);
    }
    return await callKnowledgeWorkerJson(env, principal, `/api/tree${suffix}`, requestOptions);
  }

  if (name === "knowledge_edit_file_read") {
    assertScope(principal, KNOWLEDGE_READ_SCOPES);
    const objectId = encodeURIComponent(requireArg(args.objectId, "missing_knowledge_object_id"));
    const payload = await callKnowledgeWorkerJson(env, principal, `/api/files/${objectId}`, { scopes: ["workspace:knowledge:read"], toolName: name, toolAlias: deprecatedToolAlias });
    if (args.includeContent !== true) {
      return payload;
    }
    const raw = await callKnowledgeWorkerRaw(env, principal, `/api/files/${objectId}/raw`, { scopes: ["workspace:knowledge:read"], toolName: name, toolAlias: deprecatedToolAlias });
    const payloadRecord = isRecord(payload) ? payload : {};
    return {
      ...payloadRecord,
      content: raw.isText
        ? { encoding: "text", text: new TextDecoder().decode(raw.bytes), contentType: raw.contentType }
        : { encoding: "base64", base64: bytesToBase64(raw.bytes), contentType: raw.contentType }
    };
  }

  if (name === "knowledge_edit_folder_create") {
    assertScope(principal, KNOWLEDGE_WRITE_SCOPES);
    return await callKnowledgeWorkerJson(env, principal, "/api/folders", {
      body: {
        name: requireText(args.name, "missing_knowledge_folder_name", 180),
        parentObjectId: readOptionalString(args.parentObjectId),
        parentPath: Object.prototype.hasOwnProperty.call(args, "parentPath")
          ? optionalText(args.parentPath, 800)
          : undefined
      },
      method: "POST",
      idempotencyKey: readOptionalString(args.idempotencyKey),
      scopes: ["workspace:knowledge:write"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_edit_file_upload" || name === "knowledge_edit_file_update") {
    assertScope(principal, KNOWLEDGE_WRITE_SCOPES);
    const objectId = name === "knowledge_edit_file_update"
      ? requireArg(args.objectId, "missing_knowledge_object_id")
      : undefined;
    return await callKnowledgeWorkerJson(env, principal, objectId ? `/api/files/${encodeURIComponent(objectId)}/versions` : "/api/files/upload", {
      body: knowledgeFileFormData(args, { includeParent: !objectId }),
      idempotencyKey: readOptionalString(args.idempotencyKey),
      method: "POST",
      scopes: ["workspace:knowledge:write"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_edit_file_edit") {
    assertScope(principal, KNOWLEDGE_WRITE_SCOPES);
    const objectId = encodeURIComponent(requireArg(args.objectId, "missing_knowledge_object_id"));
    return await callKnowledgeWorkerJson(env, principal, `/api/files/${objectId}/edit`, {
      body: {
        contentText: args.contentText,
        expectedCurrentVersionId: requireArg(args.expectedCurrentVersionId, "missing_knowledge_expected_version_id"),
        expectedOccurrences: args.expectedOccurrences,
        newText: args.newText,
        oldText: args.oldText,
        operation: requireArg(args.operation, "missing_knowledge_edit_operation"),
        patch: args.patch,
        text: args.text
      },
      idempotencyKey: requireArg(args.idempotencyKey, "missing_knowledge_idempotency_key"),
      method: "POST",
      scopes: ["workspace:knowledge:write"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_edit_batch") {
    assertScope(principal, KNOWLEDGE_WRITE_SCOPES);
    if (!Array.isArray(args.items) || args.items.length === 0) {
      throw new HttpError(400, "knowledge_batch_items_required");
    }
    return await callKnowledgeWorkerJson(env, principal, "/api/edit/batch", {
      body: {
        allOrNothing: args.allOrNothing !== false,
        idempotencyKey: requireArg(args.idempotencyKey, "missing_knowledge_idempotency_key"),
        items: args.items
      },
      idempotencyKey: requireArg(args.idempotencyKey, "missing_knowledge_idempotency_key"),
      method: "POST",
      scopes: ["workspace:knowledge:write"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_edit_object_rename") {
    assertScope(principal, KNOWLEDGE_WRITE_SCOPES);
    const objectId = encodeURIComponent(requireArg(args.objectId, "missing_knowledge_object_id"));
    return await callKnowledgeWorkerJson(env, principal, `/api/objects/${objectId}/rename`, {
      body: {
        expectedCurrentVersionId: readOptionalString(args.expectedCurrentVersionId),
        name: requireText(args.name, "missing_knowledge_object_name", 180)
      },
      idempotencyKey: readOptionalString(args.idempotencyKey),
      method: "POST",
      scopes: ["workspace:knowledge:write"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_edit_object_move") {
    assertScope(principal, KNOWLEDGE_WRITE_SCOPES);
    const objectId = encodeURIComponent(requireArg(args.objectId, "missing_knowledge_object_id"));
    return await callKnowledgeWorkerJson(env, principal, `/api/objects/${objectId}/move`, {
      body: {
        expectedCurrentVersionId: readOptionalString(args.expectedCurrentVersionId),
        parentObjectId: requireArg(args.parentObjectId, "missing_knowledge_parent_object_id")
      },
      idempotencyKey: requireArg(args.idempotencyKey, "missing_knowledge_idempotency_key"),
      method: "POST",
      scopes: ["workspace:knowledge:write"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_edit_object_delete") {
    assertScope(principal, KNOWLEDGE_WRITE_SCOPES);
    requireToolConfirmation(args);
    const objectId = encodeURIComponent(requireArg(args.objectId, "missing_knowledge_object_id"));
    const expectedVersionId = readOptionalString(args.expectedCurrentVersionId);
    const query = expectedVersionId
      ? `?expectedCurrentVersionId=${encodeURIComponent(expectedVersionId)}`
      : "";
    return await callKnowledgeWorkerJson(env, principal, `/api/objects/${objectId}${query}`, {
      idempotencyKey: readOptionalString(args.idempotencyKey),
      method: "DELETE",
      scopes: ["workspace:knowledge:write"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_edit_object_restore") {
    assertScope(principal, KNOWLEDGE_WRITE_SCOPES);
    const objectId = encodeURIComponent(requireArg(args.objectId, "missing_knowledge_object_id"));
    return await callKnowledgeWorkerJson(env, principal, `/api/objects/${objectId}/restore`, {
      body: {
        expectedCurrentVersionId: readOptionalString(args.expectedCurrentVersionId)
      },
      idempotencyKey: requireArg(args.idempotencyKey, "missing_knowledge_idempotency_key"),
      method: "POST",
      scopes: ["workspace:knowledge:write"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_edit_file_versions") {
    assertScope(principal, KNOWLEDGE_READ_SCOPES);
    const objectId = encodeURIComponent(requireArg(args.objectId, "missing_knowledge_object_id"));
    return await callKnowledgeWorkerJson(env, principal, `/api/files/${objectId}/versions`, {
      scopes: ["workspace:knowledge:read"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_edit_file_version_restore") {
    assertScope(principal, KNOWLEDGE_WRITE_SCOPES);
    const objectId = encodeURIComponent(requireArg(args.objectId, "missing_knowledge_object_id"));
    const versionId = encodeURIComponent(requireArg(args.versionId, "missing_knowledge_version_id"));
    return await callKnowledgeWorkerJson(env, principal, `/api/files/${objectId}/versions/${versionId}/restore`, {
      body: {
        expectedCurrentVersionId: requireArg(args.expectedCurrentVersionId, "missing_knowledge_expected_version_id")
      },
      idempotencyKey: requireArg(args.idempotencyKey, "missing_knowledge_idempotency_key"),
      method: "POST",
      scopes: ["workspace:knowledge:write"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_edit_service_update") {
    assertScope(principal, KNOWLEDGE_WRITE_SCOPES);
    const serviceId = encodeURIComponent(requireArg(args.serviceId, "missing_knowledge_service_id"));
    const info = Object.fromEntries(
      ["description", "role", "bestFor", "notFor", "keywords", "searchHints"]
        .filter((key) => Object.prototype.hasOwnProperty.call(args, key))
        .map((key) => [key, args[key]])
    );
    if (Object.keys(info).length === 0) {
      throw new HttpError(400, "knowledge_service_info_required");
    }
    return await callKnowledgeWorkerJson(env, principal, `/api/knowledge-services/${serviceId}/info`, {
      body: { info },
      method: "PATCH",
      scopes: ["workspace:knowledge:write"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_file_public_share_create") {
    assertScope(principal, KNOWLEDGE_SHARE_SCOPES);
    requireToolConfirmation(args);
    const objectId = encodeURIComponent(requireArg(args.fileId ?? args.objectId, "missing_knowledge_file_id"));
    const payload = await callKnowledgeWorkerJson(env, principal, `/api/objects/${objectId}/public-share`, {
      body: { expiry: normalizeKnowledgeShareExpiry(args.expiry) },
      method: "POST",
      scopes: ["workspace:knowledge:share"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
    return knowledgePublicShareResult(payload);
  }

  if (name === "knowledge_file_public_share_get") {
    assertScope(principal, KNOWLEDGE_SHARE_SCOPES);
    const objectId = encodeURIComponent(requireArg(args.fileId ?? args.objectId, "missing_knowledge_file_id"));
    const payload = await callKnowledgeWorkerJson(env, principal, `/api/objects/${objectId}/public-share`, {
      scopes: ["workspace:knowledge:share"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
    return knowledgePublicShareResult(payload);
  }

  if (name === "knowledge_file_public_share_revoke") {
    assertScope(principal, KNOWLEDGE_SHARE_SCOPES);
    requireToolConfirmation(args);
    const objectId = encodeURIComponent(requireArg(args.fileId ?? args.objectId, "missing_knowledge_file_id"));
    return await callKnowledgeWorkerJson(env, principal, `/api/objects/${objectId}/public-share`, {
      method: "DELETE",
      scopes: ["workspace:knowledge:share"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_service_list") {
    assertScope(principal, KNOWLEDGE_READ_SCOPES);
    return await callKnowledgeWorkerJson(env, principal, "/api/knowledge-services?view=card", { scopes: ["workspace:knowledge:read"], toolName: name, toolAlias: deprecatedToolAlias });
  }

  if (name === "knowledge_service_handbook") {
    assertScope(principal, KNOWLEDGE_READ_SCOPES);
    const serviceId = requireArg(args.serviceId, "missing_knowledge_service_id");
    return await callKnowledgeWorkerJson(env, principal, `/api/knowledge-services/${encodeURIComponent(serviceId)}/handbook`, {
      scopes: ["workspace:knowledge:read"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_service_search") {
    assertScope(principal, KNOWLEDGE_READ_SCOPES);
    const folderObjectId = readOptionalString(args.folderObjectId);
    const serviceId = readOptionalString(args.serviceId);
    if (folderObjectId && serviceId) throw new HttpError(400, "knowledge_query_target_ambiguous");
    if (!folderObjectId && !serviceId) throw new HttpError(400, "missing_knowledge_query_target");
    const target = folderObjectId
      ? `/api/knowledge-folders/${encodeURIComponent(folderObjectId)}/query`
      : `/api/knowledge-services/${encodeURIComponent(serviceId!)}/query`;
    return await callKnowledgeWorkerJson(env, principal, target, {
      body: {
        action: "search",
        limit: args.limit,
        query: requireArg(args.query, "missing_knowledge_service_search_query"),
        queryContext: knowledgeQueryContext(args.queryContext)
      },
      method: "POST",
      scopes: ["workspace:knowledge:read"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_service_grep") {
    assertScope(principal, KNOWLEDGE_READ_SCOPES);
    const folderObjectId = readOptionalString(args.folderObjectId);
    const serviceId = readOptionalString(args.serviceId);
    if (folderObjectId && serviceId) throw new HttpError(400, "knowledge_query_target_ambiguous");
    if (!folderObjectId && !serviceId) throw new HttpError(400, "missing_knowledge_query_target");
    const target = folderObjectId
      ? `/api/knowledge-folders/${encodeURIComponent(folderObjectId)}/query`
      : `/api/knowledge-services/${encodeURIComponent(serviceId!)}/query`;
    return await callKnowledgeWorkerJson(env, principal, target, {
      body: {
        action: "grep",
        caseSensitive: args.caseSensitive,
        limit: args.limit,
        pattern: requireArg(args.pattern, "missing_knowledge_service_grep_pattern"),
        queryContext: knowledgeQueryContext(args.queryContext)
      },
      method: "POST",
      scopes: ["workspace:knowledge:read"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_service_read") {
    assertScope(principal, KNOWLEDGE_READ_SCOPES);
    const serviceId = readOptionalString(args.serviceId);
    const objectId = readOptionalString(args.objectId);
    if (!serviceId && objectId) {
      return callMcpTool("knowledge_edit_file_read", { includeContent: args.includeContent !== false, objectId }, env, principal, requestId, executionContext);
    }
    if (!serviceId) throw new HttpError(400, "missing_knowledge_query_target");
    const path = readOptionalString(args.path);
    const relativePath = readOptionalString(args.relativePath);
    if (!objectId && !path && !relativePath) {
      throw new HttpError(400, "missing_knowledge_service_read_target");
    }
    return await callKnowledgeWorkerJson(env, principal, `/api/knowledge-services/${encodeURIComponent(serviceId)}/query`, {
      body: {
        action: "read",
        objectId,
        path,
        queryContext: knowledgeQueryContext(args.queryContext),
        relativePath
      },
      method: "POST",
      scopes: ["workspace:knowledge:read"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_service_tree" || name === "knowledge_service_glob") {
    assertScope(principal, KNOWLEDGE_READ_SCOPES);
    const serviceId = requireArg(args.serviceId, "missing_knowledge_service_id");
    const action = name === "knowledge_service_tree" ? "tree" : "glob";
    return await callKnowledgeWorkerJson(env, principal, `/api/knowledge-services/${encodeURIComponent(serviceId)}/query`, {
      body: {
        action,
        depth: args.depth,
        limit: args.limit,
        pattern: name === "knowledge_service_glob"
          ? requireArg(args.pattern, "missing_knowledge_service_glob_pattern")
          : undefined,
        queryContext: knowledgeQueryContext(args.queryContext),
        relativePath: args.relativePath
      },
      method: "POST",
      scopes: ["workspace:knowledge:read"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_feedback_submit") {
    assertScope(principal, KNOWLEDGE_READ_SCOPES);
    const serviceId = readOptionalString(args.serviceId);
    const rootObjectId = readOptionalString(args.rootObjectId);
    if (!serviceId && !rootObjectId) {
      throw new HttpError(400, "missing_knowledge_feedback_target");
    }
    return await callKnowledgeWorkerJson(env, principal, "/api/feedback", {
      body: {
        changeSetId: readOptionalString(args.changeSetId),
        context: isRecord(args.context) ? args.context : undefined,
        kind: requireArg(args.kind, "missing_knowledge_feedback_kind"),
        message: requireText(args.message, "missing_knowledge_feedback_message", 4000),
        objectId: readOptionalString(args.objectId),
        queryId: readOptionalString(args.queryId),
        queryStepId: readOptionalString(args.queryStepId),
        rootObjectId,
        serviceId
      },
      idempotencyKey: requireArg(args.idempotencyKey, "missing_knowledge_idempotency_key"),
      method: "POST",
      scopes: ["workspace:knowledge:read"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_feedback_list_mine") {
    assertScope(principal, KNOWLEDGE_READ_SCOPES);
    const query = new URLSearchParams();
    if (args.serviceId !== undefined) {
      query.set("serviceId", requireArg(args.serviceId, "missing_knowledge_service_id"));
    }
    if (args.limit !== undefined) query.set("limit", String(args.limit));
    if (args.status !== undefined) query.set("status", requireArg(args.status, "missing_knowledge_feedback_status"));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return await callKnowledgeWorkerJson(env, principal, `/api/feedback/mine${suffix}`, {
      scopes: ["workspace:knowledge:read"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_feedback_get") {
    assertScope(principal, KNOWLEDGE_READ_SCOPES);
    const feedbackId = encodeURIComponent(requireArg(args.feedbackId, "missing_knowledge_feedback_id"));
    return await callKnowledgeWorkerJson(env, principal, `/api/feedback/${feedbackId}`, {
      scopes: ["workspace:knowledge:read"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_feedback_list") {
    assertScope(principal, KNOWLEDGE_READ_SCOPES);
    const serviceId = readOptionalString(args.serviceId);
    const rootObjectId = readOptionalString(args.rootObjectId);
    if (!serviceId && !rootObjectId) {
      throw new HttpError(400, "missing_knowledge_feedback_target");
    }
    const query = new URLSearchParams();
    if (serviceId) query.set("serviceId", serviceId);
    if (rootObjectId) query.set("rootObjectId", rootObjectId);
    if (args.limit !== undefined) query.set("limit", String(args.limit));
    if (args.status !== undefined) query.set("status", requireArg(args.status, "missing_knowledge_feedback_status"));
    return await callKnowledgeWorkerJson(env, principal, `/api/feedback?${query.toString()}`, {
      scopes: ["workspace:knowledge:read"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (name === "knowledge_feedback_status_update") {
    assertScope(principal, KNOWLEDGE_WRITE_SCOPES);
    const feedbackId = encodeURIComponent(requireArg(args.feedbackId, "missing_knowledge_feedback_id"));
    return await callKnowledgeWorkerJson(env, principal, `/api/feedback/${feedbackId}`, {
      body: { status: requireArg(args.status, "missing_knowledge_feedback_status") },
      method: "PATCH",
      scopes: ["workspace:knowledge:write"],
      toolName: name,
      toolAlias: deprecatedToolAlias
    });
  }

  if (["mail_list", "mail_get", "mail_get_attachment", "mail_update", "mail_send", "mail_reply"].includes(name)) {
    assertScope(principal, [name === "mail_send" || name === "mail_reply" ? "workspace:mail:send" : name === "mail_update" ? "workspace:mail:write" : "workspace:mail:read"]);
    return callMailRuntime(env, principal, name, args);
  }

  if (name === "apps_list_inventory") {
    assertScope(principal, APPS_APP_READ_SCOPES);
    assertScope(principal, APPS_SKILL_READ_SCOPES);
    return await callAppsWorker(env, principal, "/inventory", {
      appsScopes: ["apps:apps:read", "apps:skills:read", "apps:mates:read"]
    });
  }

  if (name === "mate_call_start") {
    assertScope(principal, APPS_MATE_READ_SCOPES);
    const mateId = requireArg(args.mateId, "missing_mate_id");
    const created = await callMateRuntime(env, principal, mateId, "/tasks", {
      body: {
        instruction: requireText(args.instruction, "missing_mate_instruction", 12_000),
        channel: "mate_call",
        ...(readOptionalString(args.title) ? { title: readOptionalString(args.title) } : {}),
        ...(readOptionalString(args.threadId) ? { threadId: readOptionalString(args.threadId) } : {}),
        ...(readOptionalString(args.mateCallId) ? { mateCallId: readOptionalString(args.mateCallId) } : {}),
        ...(readOptionalString(args.conversationId) ? { conversationId: readOptionalString(args.conversationId) } : {}),
        ...(readOptionalString(args.parentTaskId) ? { parentTaskId: readOptionalString(args.parentTaskId) } : {}),
        ...(isRecord(args.context) ? { context: args.context } : {})
      },
      method: "POST"
    });
    const task = isRecord(created.task) ? created.task : {};
    const taskId = requireArg(task.id, "mate_runtime_task_missing");
    const started = await callMateRuntime(env, principal, mateId, `/tasks/${encodeURIComponent(taskId)}/run`, {
      method: "POST",
      ...(args.waitForConclusion === false ? {body:{background:true}} : {})
    });
    return {...started,taskId,threadId:task.threadId,mateCallId:task.mateCallId};
  }

  if (name === "mate_call_receipt") {
    assertScope(principal,APPS_MATE_READ_SCOPES);
    const mateId=requireArg(args.mateId,"missing_mate_id");
    const taskId=requireArg(args.taskId,"missing_mate_task_id");
    return callMateRuntime(env,principal,mateId,`/tasks/${encodeURIComponent(taskId)}/receipt`,{method:"POST"});
  }
  if (name === "mate_call_follow") {
    assertScope(principal, APPS_MATE_READ_SCOPES);
    const mateId = requireArg(args.mateId, "missing_mate_id");
    const identifiers = [args.taskId,args.threadId,args.mateCallId].filter(value => readOptionalString(value));
    if (identifiers.length !== 1) throw new HttpError(400,"mate_call_identifier_required");
    const taskId = readOptionalString(args.taskId);
    const identifier = readOptionalString(args.threadId) || readOptionalString(args.mateCallId);
    const query = readOptionalString(args.cursor) ? `?cursor=${encodeURIComponent(String(args.cursor))}` : "";
    return callMateRuntime(env, principal, mateId, taskId ? `/tasks/${encodeURIComponent(taskId)}` : `/threads/${encodeURIComponent(identifier!)}${query}`);
  }

  if (name === "mate_call_list") {
    assertScope(principal, APPS_MATE_READ_SCOPES);
    const mateId = requireArg(args.mateId, "missing_mate_id");
    if ([args.threadId,args.mateCallId,args.conversationId].filter(value=>readOptionalString(value)).length>1) throw new HttpError(400,"mate_call_identifier_ambiguous");
    const identifier = readOptionalString(args.threadId) || readOptionalString(args.mateCallId);
    const cursor = readOptionalString(args.cursor);
    if (identifier) return callMateRuntime(env,principal,mateId,`/threads/${encodeURIComponent(identifier)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    const conversationId = readOptionalString(args.conversationId);
    if (conversationId) return callMateRuntime(env,principal,mateId,`/tasks?conversationId=${encodeURIComponent(conversationId)}`);
    const query = new URLSearchParams({kind:readOptionalString(args.kind) || "task"});
    if (cursor) query.set("cursor",cursor);
    return callMateRuntime(env, principal, mateId, `/threads?${query}`);
  }

  if (name === "apps_list_apps") {
    assertScope(principal, APPS_APP_READ_SCOPES);
    return await callAppsWorker(env, principal, "/apps");
  }

  if (name === "apps_get_app") {
    assertScope(principal, APPS_APP_READ_SCOPES);
    return await callAppsWorker(env, principal, `/apps/${encodeURIComponent(requireArg(args.appId, "missing_app_id"))}`);
  }

  if (name === "apps_download_current_source_code") {
    assertScope(principal, APPS_APP_READ_SCOPES);
    return await downloadCurrentAppsSource(
      env,
      principal,
      requireArg(args.appId, "missing_app_id")
    );
  }

  if (name === "apps_get_app_handoff") {
    assertScope(principal, APPS_APP_READ_SCOPES);
    return await callAppsWorker(env, principal, `/apps/${encodeURIComponent(requireArg(args.appId, "missing_app_id"))}/handoff.md`);
  }

  if (name === "apps_create_app") {
    assertScope(principal, APPS_APP_WRITE_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:apps:write", "apps:apps:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args,
      requestId
    });
  }

  const mateReadTools = new Set([
    "apps_list_mates",
    "apps_mate_get",
    "apps_mate_core_review",
    "apps_mate_releases_list"
  ]);
  if (mateReadTools.has(name)) {
    assertScope(principal, APPS_MATE_READ_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:mates:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args,
      requestId
    });
  }

  const mateWriteTools = new Set([
    "apps_mate_create",
    "apps_mate_update",
    "apps_mate_core_update",
    "apps_mate_definition_update",
    "apps_mate_validate",
    "apps_mate_deploy_preview",
    "apps_mate_publish",
    "apps_mate_release_activate"
  ]);
  if (mateWriteTools.has(name)) {
    assertScope(principal, APPS_MATE_WRITE_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:mates:write", "apps:mates:admin", "apps:mates:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args,
      requestId
    });
  }

  if (name === "apps_get_mail_sdk") {
    assertScope(principal, APPS_APP_READ_SCOPES);
    return await callAppsWorker(env, principal, `/apps/${encodeURIComponent(requireArg(args.appId,"missing_app_id"))}/mail-sdk`, {appsScopes:["apps:apps:read"]});
  }
  if (name === "apps_get_auth_sdk") {
    assertScope(principal, APPS_APP_READ_SCOPES);
    return await callAppsWorker(
      env,
      principal,
      `/apps/${encodeURIComponent(requireArg(args.appId, "missing_app_id"))}/auth-sdk`
    );
  }

  if (name === "apps_get_provisioning_status") {
    assertScope(principal, APPS_APP_READ_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:apps:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args,
      requestId
    });
  }

  if (name === "apps_retry_provisioning_job") {
    assertScope(principal, APPS_APP_WRITE_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:apps:write", "apps:apps:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args,
      requestId
    });
  }

  if (name === "apps_update_app_config") {
    assertScope(principal, APPS_APP_WRITE_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:apps:write", "apps:apps:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args,
      requestId
    });
  }

  if (name === "apps_pages_deploy" || name === "apps_worker_deploy") {
    assertScope(principal, APPS_APP_WRITE_SCOPES);
    assertScope(principal, APPS_WRITE_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:apps:write", "apps:deploy:production", "apps:apps:admin", "apps:apps:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args,
      requestId
    });
  }

  if (name === "apps_deployments_list" || name === "apps_deployments_get") {
    assertScope(principal, APPS_APP_READ_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:apps:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args
    });
  }

  if (name === "apps_deployments_publish" || name === "apps_deployments_rollback") {
    assertScope(principal, APPS_WRITE_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:apps:write", "apps:deploy:production", "apps:apps:admin", "apps:apps:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args
    });
  }

  if (name === "apps_d1_migrations_apply") {
    assertScope(principal, APPS_APP_WRITE_SCOPES);
    assertScope(principal, APPS_WRITE_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:apps:write", "apps:deploy:production", "apps:apps:admin", "apps:apps:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args
    });
  }

  if (name === "apps_d1_migrations_list" || name === "apps_d1_schema_get") {
    assertScope(principal, APPS_APP_READ_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:apps:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args
    });
  }

  if (
    name === "apps_env_vars_list"
    || name === "apps_secrets_status"
    || name === "apps_kv_keys_list"
    || name === "apps_kv_value_get"
    || name === "apps_r2_objects_list"
    || name === "apps_r2_object_get"
  ) {
    assertScope(principal, APPS_APP_READ_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:apps:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args
    });
  }

  if (
    name === "apps_env_vars_set"
    || name === "apps_env_vars_delete"
    || name === "apps_secrets_declare"
    || name === "apps_kv_value_put"
    || name === "apps_kv_value_delete"
    || name === "apps_r2_object_put"
    || name === "apps_r2_object_delete"
  ) {
    assertScope(principal, APPS_APP_WRITE_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:apps:write", "apps:apps:admin", "apps:apps:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args
    });
  }

  if (name === "apps_list_skills") {
    assertScope(principal, APPS_SKILL_READ_SCOPES);
    return await callAppsWorker(env, principal, "/skills");
  }

  if (name === "apps_get_skill") {
    assertScope(principal, APPS_SKILL_READ_SCOPES);
    return await callAppsWorker(env, principal, `/skills/${encodeURIComponent(requireArg(args.skillId, "missing_skill_id"))}`);
  }

  if (name === "apps_skill_validate" || name === "apps_skill_submit" || name === "apps_skill_update") {
    assertScope(principal, APPS_SKILL_WRITE_SCOPES);
    return await callAppsWorker(env, principal, "/mcp", {
      appsScopes: ["apps:skills:write", "apps:skills:admin", "apps:skills:read"],
      method: "POST",
      rpcMethod: "tools/call",
      rpcName: name,
      rpcArgs: args
    });
  }

  if (name.startsWith("apps_")) {
    throw new HttpError(404, "unknown_mcp_tool");
  }

  throw new HttpError(404, "unknown_mcp_tool");
}

function normalizedUtcTimestamp(value: string | undefined) {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const timestamp = new Date(normalized);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toISOString();
}

function knowledgeToolAdvertisedForPrincipal(name: string, principal: Principal) {
  if (!name.startsWith("knowledge_")) return true;
  const canRead = principal.scopes.includes("workspace:*")
    || principal.scopes.includes("workspace:knowledge:read");
  const canWrite = principal.scopes.includes("workspace:*")
    || principal.scopes.includes("workspace:knowledge:write");
  const canShare = principal.scopes.includes("workspace:*")
    || principal.scopes.includes("workspace:knowledge:share");
  if (name === "knowledge_feedback_list" || name === "knowledge_feedback_status_update") {
    return canRead && canWrite;
  }
  if (name.startsWith("knowledge_service_") || name.startsWith("knowledge_feedback_")) {
    return canRead;
  }
  if (name.startsWith("knowledge_file_public_share_")) {
    return canShare;
  }
  if (name === "knowledge_edit_list" || name === "knowledge_edit_file_read") {
    return canRead && canWrite;
  }
  if (name.startsWith("knowledge_edit_")) {
    return canWrite;
  }
  return canRead;
}

function isRemovedPublicTool(name: string) {
  return [
    "knowledge_audit_change_get",
    "knowledge_audit_change_list",
    "knowledge_audit_diff_read",
    "knowledge_file_get",
    "knowledge_file_update",
    "knowledge_file_upload",
    "knowledge_folder_create",
    "knowledge_owner_transfer_decide",
    "knowledge_owner_transfer_initiate",
    "knowledge_owner_transfer_list",
    "knowledge_public_share_create",
    "knowledge_services_list",
    "knowledge_tree"
  ].includes(name);
}

function isRemovedKnowledgeServiceTool(name: string) {
  return [
    "knowledge_service_publish",
    "knowledge_service_publish_version",
    "knowledge_service_update_access",
    "knowledge_service_manage_list",
    "knowledge_service_get",
    "knowledge_service_download",
    "knowledge_skill_publish",
    "knowledge_skills_list",
    "knowledge_skill_get",
    "knowledge_skill_download"
  ].includes(name);
}

function removedKnowledgeServiceToolError(name: string) {
  if (name === "knowledge_service_download" || name === "knowledge_skill_download") {
    return new HttpError(410, "knowledge_service_package_removed", "Knowledge Services are queried online and can no longer be downloaded as installable packages.");
  }
  if (name === "knowledge_service_get" || name === "knowledge_skill_get") {
    return new HttpError(410, "knowledge_service_get_removed", "Use knowledge_service_handbook to read the service guide, then use search, grep, or read.");
  }
  if (name.startsWith("knowledge_skill") || name === "knowledge_skills_list") {
    return new HttpError(410, "knowledge_skill_tools_removed", "Knowledge bases are services, not installable Skills. Use knowledge_service_list and knowledge_service_handbook.");
  }
  return new HttpError(410, "knowledge_service_management_portal_only", "Knowledge Service publishing and access management are available only in the Frontier Workspace Portal.");
}
