import type { McpToolDefinition } from "./publicTools.ts";

export type RuntimeWorkspacePassRisk = "medium" | "high" | "critical";

export type RuntimeWorkspacePassToolDefinition = McpToolDefinition & {
  capacity?: { group: "ai_capacity" | "forum_hub"; child: string };
  runtimePolicy: {
    authorization: "invoking_user";
    readActions?: string[];
    writeActions?: string[];
    writeMode: "never" | "always" | "actions";
    writeRisk?: RuntimeWorkspacePassRisk;
  };
};

const READ_TOOLS = new Set([
  "mail_list", "mail_get", "mail_get_attachment",
  "models_list",
  "tools_web_search",
  "tools_web_reader",
  "tools_image_generation",
  "tools_video_generation",
  "tools_audio_asr",
  "tools_audio_tts",
  "tools_jev",
  "forum_read",
  "hub_search",
  "hub_skill_download",
  "knowledge_list",
  "knowledge_service_handbook",
  "knowledge_query",
  "knowledge_file_read",
  "knowledge_file_versions",
  "knowledge_feedback_read"
]);

const WRITE_TOOLS = new Map<string, RuntimeWorkspacePassRisk>([
  ["mail_update", "medium"],
  ["mail_send", "high"], ["mail_reply", "high"],
  ["forum_write", "high"],
  ["forum_media", "high"],
  ["knowledge_library_write", "high"],
  ["knowledge_library_delete", "critical"],
  ["knowledge_service_update", "high"],
  ["knowledge_feedback_submit", "medium"],
  ["knowledge_feedback_manage", "medium"],
  // APPS administration and Hub publishing are not available to cloud Runtime.
]);

const ACTION_TOOLS = new Map<string, { readActions: string[]; writeActions: string[]; risk: RuntimeWorkspacePassRisk }>([
  ["knowledge_share", { readActions: ["get"], writeActions: ["create", "revoke"], risk: "high" }]
]);

const CAPACITY = new Map<string, RuntimeWorkspacePassToolDefinition["capacity"]>([
  ["models_list", { group: "ai_capacity", child: "models" }],
  ["tools_web_search", { group: "ai_capacity", child: "web" }],
  ["tools_web_reader", { group: "ai_capacity", child: "web" }],
  ["tools_image_generation", { group: "ai_capacity", child: "image" }],
  ["tools_video_generation", { group: "ai_capacity", child: "video" }],
  ["tools_audio_asr", { group: "ai_capacity", child: "audio" }],
  ["tools_audio_tts", { group: "ai_capacity", child: "audio" }],
  ["tools_jev", { group: "ai_capacity", child: "jev" }],
  ["forum_read", { group: "forum_hub", child: "forum_read" }],
  ["forum_write", { group: "forum_hub", child: "forum_write" }],
  ["forum_media", { group: "forum_hub", child: "forum_media" }],
  ["hub_search", { group: "forum_hub", child: "hub_discovery" }],
  ["hub_skill_download", { group: "forum_hub", child: "hub_skill" }]
]);

export function runtimeWorkspacePassToolDefinitions(definitions: McpToolDefinition[]) {
  return definitions.flatMap((definition): RuntimeWorkspacePassToolDefinition[] => {
    const policy = runtimeWorkspacePassToolPolicy(definition.name);
    return policy ? [{ ...definition, ...(CAPACITY.get(definition.name) ? { capacity: CAPACITY.get(definition.name) } : {}), runtimePolicy: policy }] : [];
  });
}

export function runtimeWorkspacePassToolPolicy(name: string) {
  if (READ_TOOLS.has(name)) {
    return { authorization: "invoking_user" as const, writeMode: "never" as const };
  }
  const writeRisk = WRITE_TOOLS.get(name);
  if (writeRisk) {
    return {
      authorization: "invoking_user" as const,
      writeMode: "always" as const,
      writeRisk
    };
  }
  const actionPolicy = ACTION_TOOLS.get(name);
  if (actionPolicy) {
    return {
      authorization: "invoking_user" as const,
      readActions: [...actionPolicy.readActions],
      writeActions: [...actionPolicy.writeActions],
      writeMode: "actions" as const,
      writeRisk: actionPolicy.risk
    };
  }
  return undefined;
}

export function runtimeWorkspacePassWriteRisk(name: string, input: Record<string, unknown>) {
  const policy = runtimeWorkspacePassToolPolicy(name);
  if (!policy || policy.writeMode === "never") return undefined;
  if (policy.writeMode === "always") return policy.writeRisk;
  const action = typeof input.action === "string" ? input.action : "";
  return policy.readActions?.includes(action) ? undefined : policy.writeRisk;
}
