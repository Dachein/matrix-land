import { WORKSPACE_APP_COVER_GUIDANCE } from "../../../src/shared/mcpHandbook.ts";
import { mailToolDefinitions } from "../../../src/shared/mailTools.ts";
import type { Principal } from "./types.ts";

export type McpToolDefinition = {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  title?: string;
};

type ActionRoute = {
  action: string;
  internalName: string;
};

type PublicToolSpec = {
  actions?: ActionRoute[];
  description: string;
  directInternalName?: string;
  name: string;
  title?: string;
  scopes?: string[];
};

export type PublicToolRoute =
  | { kind: "internal"; args: Record<string, unknown>; internalName: string };

const PUBLIC_TOOL_SPECS: PublicToolSpec[] = [
  {
    name: "ping_who_am_i",
    description: "Always call this first to diagnose Workspace MCP setup, connection, authentication, CLI upgrade or reinstall, and guided-use issues. Returns account, connection, server, protocol, structured checks, and the required recovery action without credential material. If authorization prevents the call, follow the reauthentication details in the 401 response.",
    directInternalName: "ping_who_am_i"
  },
  {
    name: "models_list",
    description: "List the Workspace LLM gateway models available to this account with tri-state capability and endpoint support, context limits, and pricing. Capability values are supported, unsupported, or unknown; unknown means the gateway has not declared the value and must never be read as unsupported.",
    directInternalName: "models_list"
  },
  {
    name: "tools_image_generation",
    title: "AI Resources · Image · Generate",
    description: "Generate or edit images on Cloudflare with gpt-image-2.5-flare (default, fast everyday generation) or gpt-image-2.5-sunburst (precise editing). Both accept reference images and PNG, WebP or JPEG output; use opaque or auto backgrounds. Returns a private Artifact preview link that expires after seven days; save a copy to Knowledge if persistence is needed.",
    directInternalName: "image_generation"
  },
  {
    name: "tools_video_generation",
    title: "AI Resources · Video · Generate",
    description: "Generate videos through Cloudflare. Returns a private Artifact preview link that expires after seven days; save a copy to Knowledge if persistence is needed.",
    directInternalName: "video_generation"
  },
  {
    name: "tools_web_search",
    title: "AI Resources · Web · Search",
    description: "Search the public web as a shared MCP capability.",
    directInternalName: "web_search"
  },
  {
    name: "tools_web_reader",
    title: "AI Resources · Web · Read",
    description: "Read a public HTTPS webpage or PDF as a shared MCP capability.",
    directInternalName: "web_reader"
  },
  {
    name: "tools_audio_asr",
    title: "AI Resources · Audio · ASR",
    description: "Transcribe public HTTPS audio with Whisper as a shared MCP capability.",
    directInternalName: "whisper_asr"
  },
  {
    name: "tools_audio_tts",
    title: "AI Resources · Audio · TTS",
    description: "Generate speech with MiniMax Speech 2.8 Turbo through Cloudflare Workers AI and return a private Artifact preview link that expires after seven days.",
    directInternalName: "audio_tts"
  },
  {
    name: "tools_jev",
    title: "AI Resources · JEV",
    description: "Evaluate structured state with JEV through the shared Cloudflare Workers AI binding.",
    directInternalName: "jev"
  },
  {
    name: "forum_read",
    description: "Browse Forum categories, search topics, or read one complete topic.",
    scopes: ["workspace:forum:read"],
    actions: [
      { action: "categories", internalName: "forum_list_categories" },
      { action: "search_topics", internalName: "forum_search_topics" },
      { action: "get_topic", internalName: "forum_get_topic" }
    ]
  },
  {
    name: "forum_write",
    description: "Create or update a Forum topic, or reply to a discussion.",
    scopes: ["workspace:forum:write"],
    actions: [
      { action: "create_topic", internalName: "forum_create_topic" },
      { action: "update_topic", internalName: "forum_update_topic" },
      { action: "create_reply", internalName: "forum_create_reply" }
    ]
  },
  {
    name: "forum_media",
    description: "Import Forum media from an HTTPS URL or manage the begin/finalize direct-upload flow.",
    scopes: ["workspace:forum:write"],
    actions: [
      { action: "import_url", internalName: "forum_upload_media" },
      { action: "begin", internalName: "upload_begin" },
      { action: "finalize", internalName: "upload_finalize" }
    ]
  },
  {
    name: "hub_search",
    description: "Search listed Workspace Hub Apps and Skills. Use type=skill to replace the former separate Skill listing operation.",
    scopes: ["workspace:hub:read", "workspace:market:read"],
    directInternalName: "hub_search"
  },
  {
    name: "hub_skill_download",
    description: "Download the latest authorized Skill Hub package for local Agent installation.",
    scopes: ["workspace:hub:read", "workspace:market:read"],
    directInternalName: "hub_skill_download"
  },
  {
    name: "apps_deployment_submit_listing",
    description: "Submit a APPS App or Skill to the Hub review workflow. " + WORKSPACE_APP_COVER_GUIDANCE,
    scopes: ["workspace:apps:write"],
    directInternalName: "hub_submit_listing"
  },
  {
    name: "knowledge_list",
    description: "List Knowledge items the current user can read, including personal and shared items that are not enabled as Knowledge Services. Each item reports current read/write permissions and an optional knowledgeServiceId for Handbook and indexed search.",
    scopes: ["workspace:knowledge:read"],
    directInternalName: "knowledge_edit_list"
  },
  {
    name: "knowledge_service_handbook",
    description: "Read the Handbook for one enabled Knowledge Service.",
    scopes: ["workspace:knowledge:read"],
    directInternalName: "knowledge_service_handbook"
  },
  {
    name: "knowledge_query",
    description: "Search or grep a readable Knowledge folder using folderObjectId. Use serviceId for indexed queries and service-specific tree or glob navigation.",
    scopes: ["workspace:knowledge:read"],
    actions: [
      { action: "search", internalName: "knowledge_service_search" },
      { action: "grep", internalName: "knowledge_service_grep" },
      { action: "tree", internalName: "knowledge_service_tree" },
      { action: "glob", internalName: "knowledge_service_glob" }
    ]
  },
  {
    name: "knowledge_file_read",
    description: "Read an authorized Knowledge file by objectId, or a visible service file by serviceId and path. With objectId, use includeContent=false for metadata only.",
    scopes: ["workspace:knowledge:read"],
    directInternalName: "knowledge_service_read"
  },
  {
    name: "knowledge_file_versions",
    description: "List immutable versions of one accessible Knowledge file.",
    scopes: ["workspace:knowledge:read"],
    directInternalName: "knowledge_edit_file_versions"
  },
  {
    name: "knowledge_library_write",
    description: "Create and maintain Knowledge library folders, files, and immutable versions.",
    scopes: ["workspace:knowledge:write"],
    actions: [
      { action: "upload", internalName: "knowledge_edit_file_upload" },
      { action: "update", internalName: "knowledge_edit_file_update" },
      { action: "edit", internalName: "knowledge_edit_file_edit" },
      { action: "batch", internalName: "knowledge_edit_batch" },
      { action: "create_folder", internalName: "knowledge_edit_folder_create" },
      { action: "rename", internalName: "knowledge_edit_object_rename" },
      { action: "move", internalName: "knowledge_edit_object_move" },
      { action: "restore", internalName: "knowledge_edit_object_restore" },
      { action: "restore_version", internalName: "knowledge_edit_file_version_restore" }
    ]
  },
  {
    name: "knowledge_library_delete",
    description: "Delete one Knowledge file or folder after explicit confirmation.",
    scopes: ["workspace:knowledge:write"],
    directInternalName: "knowledge_edit_object_delete"
  },
  {
    name: "knowledge_service_update",
    description: "Update the routing Card for an active Knowledge Service without changing access or ownership.",
    scopes: ["workspace:knowledge:write"],
    directInternalName: "knowledge_edit_service_update"
  },
  {
    name: "knowledge_share",
    description: "Get, create, or revoke a public link for one Knowledge file.",
    scopes: ["workspace:knowledge:share"],
    actions: [
      { action: "get", internalName: "knowledge_file_public_share_get" },
      { action: "create", internalName: "knowledge_file_public_share_create" },
      { action: "revoke", internalName: "knowledge_file_public_share_revoke" }
    ]
  },
  {
    name: "knowledge_feedback_submit",
    description: "Submit idempotent feedback against a visible Knowledge Service or Root Folder.",
    scopes: ["workspace:knowledge:read"],
    directInternalName: "knowledge_feedback_submit"
  },
  {
    name: "knowledge_feedback_read",
    description: "Read feedback submitted by the current user or list feedback managed for an authorized Root.",
    scopes: ["workspace:knowledge:read"],
    actions: [
      { action: "list_mine", internalName: "knowledge_feedback_list_mine" },
      { action: "get", internalName: "knowledge_feedback_get" },
      { action: "list_managed", internalName: "knowledge_feedback_list" }
    ]
  },
  {
    name: "knowledge_feedback_manage",
    description: "Update the status of a managed Knowledge feedback item.",
    scopes: ["workspace:knowledge:write"],
    directInternalName: "knowledge_feedback_status_update"
  },
  {
    name: "app_mcp_accessible_list",
    description: "List published MCP-enabled Apps accessible to the current user.",
    scopes: ["workspace:apps:read", "workspace:apps:write"],
    directInternalName: "app_mcp_accessible_list"
  },
  {
    name: "app_mcp_tools_list",
    description: "List the current role-filtered tools for one accessible MCP-enabled App.",
    scopes: ["workspace:apps:read", "workspace:apps:write"],
    directInternalName: "app_mcp_tools_list"
  },
  {
    name: "app_mcp_tool_call",
    description: "Call one registered tool in an accessible MCP-enabled App.",
    scopes: ["workspace:apps:read", "workspace:apps:write"],
    directInternalName: "app_mcp_tool_call"
  },
  ...mailToolDefinitions.map(({ name, description }) => ({
    name, directInternalName: name, description,
    scopes: [name === "mail_send" || name === "mail_reply" ? "workspace:mail:send" : name === "mail_update" ? "workspace:mail:write" : "workspace:mail:read"]
  })),
  {
    name: "mate_call",
    description: "Start, reply to, follow, or list current-user work Threads. The returned threadId and Mate Call ID preserve continuity across Agent calls and email replies; taskId identifies one execution. User identity comes from the MCP connection.",
    scopes: ["workspace:apps:read", "workspace:apps:write"],
    actions: [
      { action: "start", internalName: "mate_call_start" },
      { action: "follow", internalName: "mate_call_follow" },
      { action: "list", internalName: "mate_call_list" },
      { action: "receipt", internalName: "mate_call_receipt" }
    ]
  },
  {
    name: "mate_builder_read",
    description: "List and review owned custom Mate identities, Soul, Handbook, mail.md, Drafts, and immutable Releases.",
    scopes: ["workspace:apps:read", "workspace:apps:write"],
    actions: [
      { action: "list", internalName: "apps_list_mates" },
      { action: "get", internalName: "apps_mate_get" },
      { action: "core_review", internalName: "apps_mate_core_review" },
      { action: "releases", internalName: "apps_mate_releases_list" }
    ]
  },
  {
    name: "mate_builder_write",
    description: "Create or update a Mate Draft, deploy an owner-testable Preview Release, publish that exact Release, or activate a rollback Release. Use creationProfile=personal_mate for the same personal Mate defaults as Web and the miniapp.",
    scopes: ["workspace:apps:write"],
    actions: [
      { action: "create", internalName: "apps_mate_create" },
      { action: "update", internalName: "apps_mate_update" },
      { action: "core_update", internalName: "apps_mate_core_update" },
      { action: "definition_update", internalName: "apps_mate_definition_update" },
      { action: "validate", internalName: "apps_mate_validate" },
      { action: "deploy_preview", internalName: "apps_mate_deploy_preview" },
      { action: "publish", internalName: "apps_mate_publish" },
      { action: "activate_release", internalName: "apps_mate_release_activate" }
    ]
  },
  {
    name: "apps_inventory",
    description: "List manageable APPS inventory, Apps, Skills, or Mates.",
    scopes: ["workspace:apps:read", "workspace:apps:write"],
    actions: [
      { action: "all", internalName: "apps_list_inventory" },
      { action: "apps", internalName: "apps_list_apps" },
      { action: "skills", internalName: "apps_list_skills" }
    ]
  },
  {
    name: "apps_app_read",
    description: "Read a APPS App developer context, current deployed source, or Auth/Mail SDK guidance.",
    scopes: ["workspace:apps:read", "workspace:apps:write"],
    actions: [
      { action: "get", internalName: "apps_get_app" },
      { action: "download_source", internalName: "apps_download_current_source_code" },
      { action: "auth_sdk", internalName: "apps_get_auth_sdk" },
      { action: "mail_sdk", internalName: "apps_get_mail_sdk" }
    ]
  },
  {
    name: "apps_app_write",
    description: "Create a APPS App or update its governed configuration. " + WORKSPACE_APP_COVER_GUIDANCE,
    scopes: ["workspace:apps:write"],
    actions: [
      { action: "create", internalName: "apps_create_app" },
      { action: "update_config", internalName: "apps_update_app_config" }
    ]
  },
  {
    name: "apps_provisioning",
    description: "Read or retry APPS App resource provisioning.",
    scopes: ["workspace:apps:write"],
    actions: [
      { action: "status", internalName: "apps_get_provisioning_status" },
      { action: "retry", internalName: "apps_retry_provisioning_job" }
    ]
  },
  {
    name: "apps_deploy_prepare",
    description: "Create a ready, unpublished Pages or Worker deployment. " + WORKSPACE_APP_COVER_GUIDANCE,
    scopes: ["workspace:apps:write"],
    actions: [
      { action: "pages", internalName: "apps_pages_deploy" },
      { action: "worker", internalName: "apps_worker_deploy" }
    ]
  },
  {
    name: "apps_deployment_read",
    description: "List APPS deployments or read one deployment and its status.",
    scopes: ["workspace:apps:read", "workspace:apps:write"],
    actions: [
      { action: "list", internalName: "apps_deployments_list" },
      { action: "get", internalName: "apps_deployments_get" }
    ]
  },
  {
    name: "apps_deployment_release",
    description: "Publish a ready deployment after explicit approval, with an optional Workspace Release Readiness report/self-check controlled by the platform gate, or roll back to a previous deployment.",
    scopes: ["workspace:apps:write"],
    actions: [
      { action: "publish", internalName: "apps_deployments_publish" },
      { action: "rollback", internalName: "apps_deployments_rollback" }
    ]
  },
  {
    name: "apps_database",
    description: "List or apply governed D1 migrations, or read the App-owned D1 schema.",
    scopes: ["workspace:apps:write"],
    actions: [
      { action: "migrations_list", internalName: "apps_d1_migrations_list" },
      { action: "schema_get", internalName: "apps_d1_schema_get" },
      { action: "migration_apply", internalName: "apps_d1_migrations_apply" }
    ]
  },
  {
    name: "apps_config",
    description: "Manage non-secret environment variables and declared secret metadata for a APPS App.",
    scopes: ["workspace:apps:write"],
    actions: [
      { action: "env_list", internalName: "apps_env_vars_list" },
      { action: "env_set", internalName: "apps_env_vars_set" },
      { action: "env_delete", internalName: "apps_env_vars_delete" },
      { action: "secrets_status", internalName: "apps_secrets_status" },
      { action: "secrets_declare", internalName: "apps_secrets_declare" }
    ]
  },
  {
    name: "apps_storage",
    description: "List, read, write, or delete App-owned KV values and R2 objects.",
    scopes: ["workspace:apps:write"],
    actions: [
      { action: "kv_list", internalName: "apps_kv_keys_list" },
      { action: "kv_get", internalName: "apps_kv_value_get" },
      { action: "kv_put", internalName: "apps_kv_value_put" },
      { action: "kv_delete", internalName: "apps_kv_value_delete" },
      { action: "r2_list", internalName: "apps_r2_objects_list" },
      { action: "r2_get", internalName: "apps_r2_object_get" },
      { action: "r2_put", internalName: "apps_r2_object_put" },
      { action: "r2_delete", internalName: "apps_r2_object_delete" }
    ]
  },
  {
    name: "apps_skill_read",
    description: "List readable APPS Skills or read one private Skill and its versions.",
    scopes: ["workspace:apps:read", "workspace:apps:write"],
    actions: [
      { action: "list", internalName: "apps_list_skills" },
      { action: "get", internalName: "apps_get_skill" }
    ]
  },
  {
    name: "apps_skill_write",
    description: "Validate, submit, or update a collaboratively managed APPS Skill package.",
    scopes: ["workspace:apps:write"],
    actions: [
      { action: "validate", internalName: "apps_skill_validate" },
      { action: "submit", internalName: "apps_skill_submit" },
      { action: "update", internalName: "apps_skill_update" }
    ]
  }
];

export function buildPublicMcpTools(
  internalDefinitions: McpToolDefinition[],
  principal?: Principal
): McpToolDefinition[] {
  const internalByName = new Map(internalDefinitions.map((definition) => [definition.name, definition]));
  return PUBLIC_TOOL_SPECS
    .filter((spec) => publicToolVisible(spec, principal))
    .map((spec) => publicToolDefinition(spec, internalByName));
}

export function resolvePublicToolCall(name: string, args: Record<string, unknown>): PublicToolRoute | undefined {
  const spec = PUBLIC_TOOL_SPECS.find((candidate) => candidate.name === name);
  if (!spec) return undefined;
  if (spec.directInternalName) {
    return { kind: "internal", internalName: spec.directInternalName, args };
  }

  const action = typeof args.action === "string" ? args.action : "";
  const route = spec.actions?.find((candidate) => candidate.action === action);
  if (!route) return undefined;
  const { action: _action, ...internalArgs } = args;
  return { kind: "internal", internalName: route.internalName, args: internalArgs };
}

export function publicMcpToolNames() {
  return PUBLIC_TOOL_SPECS.map((spec) => spec.name);
}

export function publicMcpToolActions(name: string) {
  return PUBLIC_TOOL_SPECS
    .find((spec) => spec.name === name)
    ?.actions
    ?.map((route) => route.action) ?? [];
}

function publicToolDefinition(spec: PublicToolSpec, internalByName: Map<string, McpToolDefinition>): McpToolDefinition {
  if (spec.directInternalName) {
    const internal = requiredInternalDefinition(spec.directInternalName, internalByName);
    const conditionalRequirements = conditionalRequirementDescription(internal.inputSchema);
    return {
      name: spec.name,
      ...(spec.title ? { title: spec.title } : {}),
      description: conditionalRequirements
        ? `${spec.description} Condition: ${conditionalRequirements}. Workspace enforces this condition on the server.`
        : spec.description,
      inputSchema: clientCompatibleObjectSchema(internal.inputSchema)
    };
  }
  const actions = (spec.actions ?? []).map((route) => ({
    action: route.action,
    schema: requiredInternalDefinition(route.internalName, internalByName).inputSchema
  }));
  return {
    name: spec.name,
    description: `${spec.description} Select one action and pass only parameters supported by that action; Workspace validates the selected action's full schema on the server.`,
    inputSchema: flatActionSchema(actions)
  };
}

function clientCompatibleObjectSchema(schema: Record<string, unknown>) {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = stringArray(schema.required);
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: schema.additionalProperties ?? false
  };
}

function flatActionSchema(actions: Array<{ action: string; schema: Record<string, unknown> }>) {
  const propertyEntries = new Map<string, Array<{
    action: string;
    required: boolean;
    schema: Record<string, unknown>;
  }>>();

  for (const entry of actions) {
    const properties = isRecord(entry.schema.properties) ? entry.schema.properties : {};
    const required = new Set(stringArray(entry.schema.required));
    for (const [name, rawSchema] of Object.entries(properties)) {
      const entries = propertyEntries.get(name) ?? [];
      entries.push({
        action: entry.action,
        required: required.has(name),
        schema: isRecord(rawSchema) ? rawSchema : {}
      });
      propertyEntries.set(name, entries);
    }
  }

  const actionRequirements = actions.map((entry) => {
    const required = stringArray(entry.schema.required);
    const conditional = conditionalRequirementDescription(entry.schema);
    const base = required.length > 0 ? `requires ${required.join(", ")}` : "no additional required parameters";
    return `${entry.action}: ${base}${conditional ? `; ${conditional}` : ""}`;
  });
  const properties: Record<string, unknown> = {
    action: {
      type: "string",
      enum: actions.map((entry) => entry.action),
      description: `Select the operation. ${actionRequirements.join("; ")}.`
    }
  };
  for (const [name, entries] of propertyEntries) {
    properties[name] = mergePropertySchemas(entries);
  }

  return {
    type: "object",
    properties,
    required: ["action"],
    additionalProperties: false
  };
}

function mergePropertySchemas(entries: Array<{
  action: string;
  required: boolean;
  schema: Record<string, unknown>;
}>) {
  const schemas = entries.map((entry) => entry.schema);
  const merged: Record<string, unknown> = {};
  const types = schemas.map((schema) => schema.type);
  if (types.every((type) => type === types[0])) {
    if (types[0] !== undefined) merged.type = types[0];
  } else if (types.every((type) => type === "number" || type === "integer")) {
    merged.type = "number";
  }

  const ignoredKeys = new Set(["type", "description", "default", "enum", "const"]);
  const candidateKeys = new Set(schemas.flatMap((schema) => Object.keys(schema)));
  for (const key of candidateKeys) {
    if (ignoredKeys.has(key)) continue;
    const values = schemas.map((schema) => schema[key]);
    if (values.every((value) => value !== undefined && sameJsonValue(value, values[0]))) {
      merged[key] = values[0];
    }
  }

  const enums = schemas.map((schema) => schema.enum);
  if (enums.every(Array.isArray)) {
    merged.enum = [...new Set(enums.flat())];
  }
  const constants = schemas.map((schema) => schema.const);
  if (constants.every((value) => value !== undefined && sameJsonValue(value, constants[0]))) {
    merged.const = constants[0];
  }
  const defaults = schemas.map((schema) => schema.default);
  if (defaults.every((value) => value !== undefined && sameJsonValue(value, defaults[0]))) {
    merged.default = defaults[0];
  }

  const descriptions = [...new Set(schemas
    .map((schema) => typeof schema.description === "string" ? schema.description.trim() : "")
    .filter(Boolean))];
  const usage = entries
    .map((entry) => `${entry.action}${entry.required ? " (required)" : ""}`)
    .join(", ");
  merged.description = `${descriptions.length === 1 ? `${descriptions[0]} ` : ""}Actions: ${usage}.`;
  return merged;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sameJsonValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function conditionalRequirementDescription(schema: Record<string, unknown>) {
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  const requiredSets = alternatives
    .filter(isRecord)
    .map((alternative) => stringArray(alternative.required))
    .filter((required) => required.length > 0);
  if (requiredSets.length === 0) return "";
  const options = requiredSets.map((required) => required.join(" + ")).join(" | ");
  return `${Array.isArray(schema.oneOf) ? "requires exactly one of" : "requires at least one of"} ${options}`;
}

function requiredInternalDefinition(name: string, internalByName: Map<string, McpToolDefinition>) {
  const definition = internalByName.get(name);
  if (!definition) throw new Error(`missing_internal_mcp_command:${name}`);
  return definition;
}

function publicToolVisible(spec: PublicToolSpec, principal?: Principal) {
  if (!principal || !spec.scopes || spec.scopes.length === 0) return true;
  return principal.scopes.includes("workspace:*") || spec.scopes.some((scope) => principal.scopes.includes(scope));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
