import { knowledgeMaintenanceUpstreamError } from "./knowledgeMaintenanceErrors.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimePrincipal } from "./types.ts";
import { ALL_WRITABLE_FOLDERS, FOLDER_EDIT_SCOPE_HEADER, validFolderEditBindings } from "../../../src/shared/mateFolderEditing.ts";
import { authorizedKnowledgeRequest, KNOWLEDGE_READ_SCOPE } from "./agentTools/knowledge.ts";

export const KNOWLEDGE_MAINTENANCE_WRITE_TOOLS = [
  "knowledge_library_write",
  "knowledge_library_delete"
] as const;

export type KnowledgeMaintenanceWriteTool = typeof KNOWLEDGE_MAINTENANCE_WRITE_TOOLS[number];

export async function browseMaintainableKnowledge(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  folderObjectId?: string
) {
  const folderIds = await resolveFolderEditScope(env, definition, principal);
  if (!folderObjectId) {
    const roots = await Promise.all(folderIds.map(async (objectId) => {
      try {
        const payload = await knowledgeMaintenanceJson(env, definition, principal, "knowledge_file_read", {
          objectId, includeContent: false
        }) as { item?: unknown };
        return payload.item;
      } catch (error) {
        // Revoked or deleted bindings are not listed. Upstream outages remain
        // visible instead of looking like an empty folder selection.
        if (error instanceof RuntimeHttpError && [403, 404].includes(error.status)) return undefined;
        throw error;
      }
    }));
    return { items: roots.filter(Boolean) };
  }
  return knowledgeMaintenanceJson(env, definition, principal, "knowledge_list", {
    ...(folderObjectId ? { folderObjectId } : {})
  });
}

export async function readMaintainableKnowledgeFile(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  objectId: string,
  includeContent: boolean
) {
  assertKnowledgeMaintenanceEnabled(definition);
  const payload = await knowledgeMaintenanceJson(env, definition, principal, "knowledge_file_read", {
    includeContent,
    objectId
  });
  return boundedMaintenanceFile(payload);
}

export async function searchMaintainableKnowledge(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  folderObjectId: string,
  query: string,
  action: "search" | "grep",
  limit: number
) {
  assertKnowledgeMaintenanceEnabled(definition);
  return knowledgeMaintenanceJson(env, definition, principal, "knowledge_query", {
    action,
    folderObjectId,
    limit,
    ...(action === "search" ? { query } : { pattern: query })
  });
}

function boundedMaintenanceFile(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const payload = value as Record<string, unknown>;
  if (!payload.content || typeof payload.content !== "object" || Array.isArray(payload.content)) return payload;
  const content = payload.content as Record<string, unknown>;
  if (content.encoding === "text" && typeof content.text === "string" && content.text.length > 120_000) {
    return {
      ...payload,
      content: {
        ...content,
        originalCharacters: content.text.length,
        text: content.text.slice(0, 120_000),
        truncated: true
      }
    };
  }
  if (content.encoding === "base64" && typeof content.base64 === "string" && content.base64.length > 160_000) {
    const { base64: _omitted, ...metadata } = content;
    return {
      ...payload,
      content: {
        ...metadata,
        omitted: true,
        originalBase64Characters: content.base64.length,
        reason: "binary_content_too_large_for_conversation"
      }
    };
  }
  return payload;
}

export async function listMaintainableKnowledgeFileVersions(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  objectId: string
) {
  assertKnowledgeMaintenanceEnabled(definition);
  return knowledgeMaintenanceJson(env, definition, principal, "knowledge_file_versions", {
    objectId
  });
}

export async function executeKnowledgeMaintenanceWrite(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  toolName: KnowledgeMaintenanceWriteTool,
  argumentsValue: Record<string, unknown>
) {
  assertKnowledgeMaintenanceEnabled(definition);
  return knowledgeMaintenanceJson(env, definition, principal, toolName, argumentsValue, "knowledge_maintenance_write_failed");
}

export function assertKnowledgeMaintenanceEnabled(definition: RuntimeDefinition) {
  const enabled = definition.release.manifest.resources.builtInToolBindings.some((binding) => (
    binding.toolId === "workspace_knowledge_maintain"
  ));
  if (!enabled) throw new RuntimeHttpError(403, "knowledge_maintenance_not_bound_to_release");
  const bindings = definition.release.manifest.resources.folderEditBindings;
  if (definition.release.manifest.resources.folderEditScope?.mode === "all_visible_to_invoking_user") return [];
  if (!validFolderEditBindings(bindings) || !bindings?.length) {
    throw new RuntimeHttpError(403, "folder_edit_scope_required");
  }
  return bindings.map((binding) => binding.folderObjectId);
}

export async function resolveFolderEditScope(env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal) {
  const fixed = assertKnowledgeMaintenanceEnabled(definition);
  if (definition.release.manifest.resources.folderEditScope?.mode !== "all_visible_to_invoking_user") return fixed;
  const now = Math.floor(Date.now() / 1_000);
  const response = await authorizedKnowledgeRequest(env, {
    appCode: definition.mate.id, appId: definition.mate.id, orgId: principal.orgId,
    description: definition.mate.description, displayName: definition.mate.displayName,
    exp: now + 300, iat: now, version: 1,
    user: { id: principal.userId, email: principal.email, name: principal.name, team: principal.orgSlug || principal.orgId }
  }, "/api/editable-folders?scope=all", { scopes: [KNOWLEDGE_READ_SCOPE] });
  if (!response.ok) throw new RuntimeHttpError(response.status >= 500 ? 502 : response.status, "editable_folders_list_failed");
  const payload = await response.json() as { items?: Array<{ id?: string; namespaceId?: string; path?: string }> };
  if (!Array.isArray(payload.items)) throw new RuntimeHttpError(502, "editable_folders_list_invalid");
  const roots = payload.items
    .filter((item) => typeof item.id === "string" && typeof item.namespaceId === "string" && typeof item.path === "string")
    .sort((left, right) => (left.path?.length ?? 0) - (right.path?.length ?? 0))
    .filter((item, index, items) => !items.slice(0, index).some((ancestor) => (
      ancestor.namespaceId === item.namespaceId && item.path?.startsWith(`${ancestor.path}/`)
    )));
  const ids = roots.map((item) => item.id as string);
  if (!ids.length) throw new RuntimeHttpError(403, "folder_edit_access_denied");
  return ids;
}

async function knowledgeMaintenanceJson(
  env: RuntimeEnv,
  definition: RuntimeDefinition,
  principal: RuntimePrincipal,
  toolName: string,
  body: Record<string, unknown>,
  errorCode = "knowledge_maintenance_read_failed"
) {
  const token = env.MATE_RUNTIME_SERVICE_TOKEN?.trim();
  if (!token) throw new RuntimeHttpError(503, "mate_runtime_service_token_not_configured");
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "x-workspace-runtime-org-id": principal.orgId,
    "x-workspace-runtime-user-id": principal.userId
  });
  if (env.MATE_AUTH_SERVICE_TOKEN?.trim()) {
    headers.set("x-workspace-runtime-auth-service-token", env.MATE_AUTH_SERVICE_TOKEN.trim());
  }
  headers.set(FOLDER_EDIT_SCOPE_HEADER, JSON.stringify(
    definition.release.manifest.resources.folderEditScope?.mode === "all_visible_to_invoking_user"
      ? ALL_WRITABLE_FOLDERS
      : assertKnowledgeMaintenanceEnabled(definition)
  ));
  if (principal.departmentId) headers.set("x-workspace-runtime-department-id", principal.departmentId);
  if (principal.departmentPath) headers.set("x-workspace-runtime-department-path", JSON.stringify(principal.departmentPath));
  if (principal.email) headers.set("x-workspace-runtime-user-email", principal.email);
  if (principal.name) headers.set("x-workspace-runtime-user-name", principal.name);
  const request = new Request(
    `https://mcp.example.invalid/internal/runtime/knowledge/tools/${encodeURIComponent(toolName)}`,
    { body: JSON.stringify(body), headers, method: "POST" }
  );
  const response = env.WORKSPACE_MCP_SERVICE ? await env.WORKSPACE_MCP_SERVICE.fetch(request) : await fetch(request);
  const raw = await response.text();
  if (!response.ok) throw knowledgeMaintenanceUpstreamError(response.status, raw, errorCode);
  try { return JSON.parse(raw) as unknown; }
  catch { throw new RuntimeHttpError(502, "knowledge_maintenance_response_invalid"); }
}
