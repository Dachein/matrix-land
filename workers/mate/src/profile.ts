import { withWorkspaceIntrinsicBuiltInToolIds } from "../../../src/shared/mate.ts";
import { modelDisplayName } from "../../../src/shared/modelDisplayName.ts";
import { listRuntimeAppMcpBindings, resolveVisibleAppMcpBinding } from "./appMcpExecutor.ts";
import { resolveFolderEditScope } from "./knowledgeMaintenanceClient.ts";
import { callRuntimeWorkspacePassTool, listRuntimeWorkspacePassTools } from "./workspacePassMcpClient.ts";
import { listVisibleKnowledgeServices } from "./knowledgeExecutor.ts";
import type { RuntimeDefinition, RuntimeEnv, RuntimePrincipal } from "./types.ts";

export type RuntimeCapabilitySelection = {
  appIds: string[];
  knowledgeServiceIds: string[];
};

export function runtimeSurfaceProfile(definition: RuntimeDefinition, mode: "live" | "preview" = "live") {
  const manifest = definition.release.manifest;
  const conversationEnabled = manifest.experiencePolicy.conversation.enabled === true;
  const taskEnabled = manifest.experiencePolicy.taskInbox.enabled === true;
  const entries = [
    ...(conversationEnabled && (mode === "preview"
      ? manifest.channels.standalone.enabled || manifest.channels.embedded.enabled
      : manifest.channels.standalone.enabled)
      ? [{ channel: "sdk" as const, kind: "conversation" as const }]
      : []),
    ...(taskEnabled && manifest.channels.inbox.email.enabled
      ? [{ channel: "email" as const, kind: "task_inbox" as const }]
      : []),
    ...(taskEnabled && manifest.channels.inbox.mateCall.enabled
      ? [{ channel: "mate_call" as const, kind: "task_inbox" as const }]
      : []),
    ...(taskEnabled && manifest.channels.inbox.schedule.enabled
      ? [{ channel: "schedule" as const, kind: "task_inbox" as const }]
      : [])
  ];
  return {
    channels: entries.map((entry) => entry.channel),
    entries,
    kind: conversationEnabled && entries.some((entry) => entry.kind === "conversation")
      ? "conversation" as const
      : taskEnabled && entries.some((entry) => entry.kind === "task_inbox")
        ? "task_inbox" as const
        : "unavailable" as const
  };
}

export function runtimeCapabilityProfile(definition: RuntimeDefinition) {
  const manifest = definition.release.manifest;
  const builtInToolBindings = withWorkspaceIntrinsicBuiltInToolIds(
    manifest.resources.builtInToolBindings.map((binding) => binding.toolId)
      .filter((id) => id !== "workspace_knowledge_maintain" || Boolean(manifest.resources.folderEditBindings?.length || manifest.resources.folderEditScope))
      .filter((id) => id !== "workspace_forum_read" && id !== "workspace_forum_post")
  ).map((toolId) => ({ toolId }));
  const modelPolicy = manifest.modelPolicy;
  const allowedModels = Array.from(new Set([
    ...(Array.isArray(modelPolicy.allowedModels) ? modelPolicy.allowedModels : []),
    modelPolicy.defaultModel
  ].filter(Boolean)));
  const allVisibleKnowledge = manifest.resources.knowledgeServiceScope?.mode === "all_visible_to_invoking_user"
    ? manifest.resources.knowledgeServiceScope
    : manifest.resources.workspacePassMcpScope?.mode === "all_authorized_for_invoking_user"
      ? { allowedOperations: ["search", "read"] as Array<"search" | "read">, mode: "all_visible_to_invoking_user" as const }
    : undefined;
  return {
    appMcp: manifest.resources.appMcpBindings.map((binding) => ({
      id: binding.appId,
      kind: "app_mcp" as const,
      manifestVersion: binding.manifestVersion,
      allowedToolNames: binding.allowedToolNames ?? [],
      authorization: "current_user_delegation" as const
    })),
    knowledge: manifest.resources.knowledgeServiceBindings.map((binding) => ({
      id: binding.serviceId,
      kind: "knowledge_service" as const,
      allowedOperations: binding.allowedOperations,
      authorization: "current_user_acl" as const
    })),
    folderEditing: (manifest.resources.folderEditBindings ?? []).map((binding) => ({
      id: binding.folderObjectId,
      kind: "folder_edit" as const,
      authorization: "current_user_acl" as const,
      writeRequiresApproval: true as const
    })),
    ...(allVisibleKnowledge ? {
      knowledgeScope: {
        allowedOperations: allVisibleKnowledge.allowedOperations,
        authorization: "invoking_user" as const,
        mode: allVisibleKnowledge.mode
      }
    } : {}),
    ...(manifest.resources.workspacePassMcpScope?.mode === "all_authorized_for_invoking_user" ? {
      workspacePassMcp: {
        authorization: "invoking_user" as const,
        domains: [...manifest.resources.workspacePassMcpScope.domains],
        mode: manifest.resources.workspacePassMcpScope.mode,
        tools: [] as Array<{ name: string; writeMode: "never" | "always" | "actions" }>
      }
    } : {}),
    skills: manifest.release.skills.map((skill) => ({
      id: skill.skillId,
      kind: "skill" as const,
      version: skill.version
    })),
    tools: builtInToolBindings.map((binding) => ({
      id: binding.toolId,
      kind: "built_in_tool" as const,
      authorization: "current_user_context" as const,
      status: "ready" as const,
      surfaces: builtInToolSurfaces(binding.toolId),
      ...(binding.toolId === "public_web_read" ? {
        engine: "kitesurf" as const,
        provider: "cloudflare_browser_run" as const
      } : binding.toolId === "public_web_search" ? {
        provider: "cloudflare_web_search" as const
      } : binding.toolId === "ocr" ? {
        provider: "cloudflare_workers_ai" as const
      } : binding.toolId === "document_read" ? {
        provider: "cloudflare_workers_ai_markdown" as const
      } : binding.toolId === "artifact_create" ? {
        provider: "workspace_knowledge_workspace" as const
      } : binding.toolId === "workspace_knowledge_maintain" ? {
        provider: "workspace_mcp" as const,
        writeRequiresApproval: true as const
      } : binding.toolId === "todo_manage" || binding.toolId === "reminder_manage" ? {
        provider: "mate_runtime" as const
      } : {})
    })),
    models: {
      allowUserSelection: allowedModels.length > 1,
      allowed: allowedModels.map((id) => ({ id, name: modelDisplayName(id) })),
      defaultModel: modelPolicy.defaultModel || "cf-openai-gpt-6-luna",
      multimodal: {
        audioInput: modelPolicy.multimodal?.audioInput === true,
        documentInput: modelPolicy.multimodal?.documentInput === true,
        imageInput: modelPolicy.multimodal?.imageInput === true
      }
    }
  };
}

function builtInToolSurfaces(toolId: string) {
  if (toolId === "public_web_read") return ["conversation", "task"] as const;
  if (toolId === "workspace_knowledge_maintain") return ["conversation", "task_approval"] as const;
  if (toolId === "workspace_forum_read") return ["conversation", "scheduled_task"] as const;
  if (toolId === "workspace_forum_post") return ["task_approval"] as const;
  if (toolId === "todo_manage" || toolId === "reminder_manage") return ["task", "runtime_api"] as const;
  if (toolId === "artifact_create") return ["live_conversation"] as const;
  return ["conversation"] as const;
}

/**
 * Resolve the Resource menu for one authenticated invocation. Release
 * bindings are the upper bound; current Knowledge ACLs and App RBAC can only
 * remove entries. Host Environment is intentionally absent from this step.
 */
export async function resolveRuntimeCapabilityProfile(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal
) {
  const configured = runtimeCapabilityProfile(definition);
  const allVisibleKnowledge = definition.release.manifest.resources.knowledgeServiceScope?.mode === "all_visible_to_invoking_user"
    ? definition.release.manifest.resources.knowledgeServiceScope
    : definition.release.manifest.resources.workspacePassMcpScope?.mode === "all_authorized_for_invoking_user"
      ? { allowedOperations: ["search", "read"] as Array<"search" | "read">, mode: "all_visible_to_invoking_user" as const }
    : undefined;
  const signal = AbortSignal.timeout(15_000);
  const [knowledgeSettled, appResults, workspacePassResult, modelCatalog] = await Promise.all([
    configured.knowledge.length || allVisibleKnowledge
      ? Promise.allSettled([listVisibleKnowledgeServices(env, principal, signal)])
      : Promise.resolve([]),
    Promise.allSettled((await listRuntimeAppMcpBindings(env, principal, definition)).map((binding) => (
      resolveVisibleAppMcpBinding(env, principal, binding)
    ))),
    definition.release.manifest.resources.workspacePassMcpScope?.mode === "all_authorized_for_invoking_user"
      ? listRuntimeWorkspacePassTools(env, principal, signal).catch(() => undefined)
      : Promise.resolve(undefined),
    env.WORKSPACE_MCP_SERVICE && env.MATE_RUNTIME_SERVICE_TOKEN
      ? callRuntimeWorkspacePassTool(env, principal, "models_list", {}, { signal: AbortSignal.timeout(5_000) })
        .catch(() => undefined)
      : Promise.resolve(undefined)
  ]);
  const knowledgeResult = knowledgeSettled[0]?.status === "fulfilled"
    ? knowledgeSettled[0].value
    : [];
  const visibleKnowledge = new Map(knowledgeResult.map((service) => [service.serviceId, service]));
  const catalog = modelCatalog && typeof modelCatalog === "object" ? modelCatalog as Record<string, unknown> : {};
  const catalogModels: unknown[] = Array.isArray(catalog.models) ? catalog.models : [];
  const modelNames = new Map<string, string>(catalogModels.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const model = value as Record<string, unknown>;
    return typeof model.id === "string" && typeof model.displayName === "string" ? [[model.id, model.displayName]] : [];
  }));
  return {
    ...configured,
    models: {
      ...configured.models,
      allowed: configured.models.allowed.map(({ id, name }) => ({ id, name: modelDisplayName(id, modelNames.get(id) || name) }))
    },
    appMcp: appResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
    folderEditing: definition.release.manifest.resources.folderEditScope?.mode === "all_visible_to_invoking_user"
      ? (await resolveFolderEditScope(env, definition, principal).catch((error) => {
        if (error instanceof Error && error.message === "folder_edit_access_denied") return [];
        throw error;
      })).map((id) => ({ id, kind: "folder_edit" as const, authorization: "current_user_acl" as const, writeRequiresApproval: true as const }))
      : configured.folderEditing,
    ...(configured.workspacePassMcp ? {
      workspacePassMcp: {
        ...configured.workspacePassMcp,
        tools: (workspacePassResult?.tools ?? []).map((tool) => ({
          name: tool.name,
          writeMode: tool.runtimePolicy.writeMode
        }))
      }
    } : {}),
    knowledge: allVisibleKnowledge
      ? knowledgeResult.map((visible) => ({
        allowedOperations: allVisibleKnowledge.allowedOperations,
        authorization: "invoking_user" as const,
        description: visible.description,
        id: visible.serviceId,
        kind: "knowledge_service" as const,
        name: visible.name
      }))
      : configured.knowledge.flatMap((binding) => {
        const visible = visibleKnowledge.get(binding.id);
        return visible ? [{
          ...binding,
          authorization: "invoking_user" as const,
          description: visible.description,
          name: visible.name
        }] : [];
      })
  };
}

export function webCapabilitySelection(url: URL, definition: RuntimeDefinition): RuntimeCapabilitySelection {
  const capabilities = runtimeCapabilityProfile(definition);
  const resources = definition.release.manifest.resources;
  const allVisibleKnowledge = resources.knowledgeServiceScope?.mode === "all_visible_to_invoking_user"
    || resources.workspacePassMcpScope?.mode === "all_authorized_for_invoking_user";
  const requestedKnowledgeId = capabilityId(url.searchParams.get("knowledgeBaseId") || url.searchParams.get("knowledgeServiceId"));
  const requestedAppId = capabilityId(url.searchParams.get("appId"));
  const hasKnowledgeSelector = url.searchParams.has("knowledgeBaseId") || url.searchParams.has("knowledgeServiceId");
  const hasAppSelector = url.searchParams.has("appId");
  return {
    knowledgeServiceIds: hasKnowledgeSelector
      ? requestedKnowledgeId && (allVisibleKnowledge || capabilities.knowledge.some((item) => item.id === requestedKnowledgeId)) ? [requestedKnowledgeId] : []
      : capabilities.knowledge.map((item) => item.id),
    appIds: hasAppSelector
      ? requestedAppId && (resources.appMcpScope?.mode === "all_visible_to_invoking_user" || capabilities.appMcp.some((item) => item.id === requestedAppId)) ? [requestedAppId] : []
      : capabilities.appMcp.map((item) => item.id)
  };
}

function capabilityId(value: string | null) {
  const output = value?.trim() ?? "";
  return output && output.length <= 180 && !/[\u0000-\u001f\u007f]/.test(output) ? output : "";
}
