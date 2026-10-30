import type { WorkspaceMateEnvironmentContext } from "@frontier-workspace/mate";
import {
  currentWorkspaceMateCapabilitySelection,
  type WorkspaceMateCapabilitySelection
} from "./chatHost.js";
import { normalizeWorkspaceMateChatIdentifier } from "./chatGrant.js";

export const WORKSPACE_MATE_EMBED_PROTOCOL_VERSION = 1 as const;
export const WORKSPACE_MATE_EMBED_CONFIGURE = "workspace.mate.embed.configure/v1" as const;
export const WORKSPACE_MATE_EMBED_READY = "workspace.mate.embed.ready/v1" as const;
export const WORKSPACE_MATE_EMBED_STATE = "workspace.mate.embed.state/v1" as const;
export const WORKSPACE_MATE_EMBED_CONVERSATION = "workspace.mate.embed.conversation/v1" as const;
export const WORKSPACE_MATE_EMBED_OPEN_WORKSPACE = "workspace.mate.embed.open-workspace/v1" as const;
export const WORKSPACE_MATE_EMBED_CLOSE = "workspace.mate.embed.close/v1" as const;
export const WORKSPACE_MATE_EMBED_ERROR = "workspace.mate.embed.error/v1" as const;

export type WorkspaceMateEmbedConfigureMessage = {
  type: typeof WORKSPACE_MATE_EMBED_CONFIGURE;
  version: typeof WORKSPACE_MATE_EMBED_PROTOCOL_VERSION;
  instanceId: string;
  mateId: string;
  conversationId?: string;
  environment?: WorkspaceMateEnvironmentContext;
  selection?: WorkspaceMateCapabilitySelection;
};

export type WorkspaceMateEmbedFrameMessage =
  | {
      type: typeof WORKSPACE_MATE_EMBED_READY;
      version: typeof WORKSPACE_MATE_EMBED_PROTOCOL_VERSION;
      instanceId: string;
      mateId: string;
    }
  | {
      type: typeof WORKSPACE_MATE_EMBED_STATE;
      version: typeof WORKSPACE_MATE_EMBED_PROTOCOL_VERSION;
      instanceId: string;
      mateId: string;
      state: "loading" | "ready" | "error";
    }
  | {
      type: typeof WORKSPACE_MATE_EMBED_CONVERSATION;
      version: typeof WORKSPACE_MATE_EMBED_PROTOCOL_VERSION;
      instanceId: string;
      mateId: string;
      conversationId: string;
    }
  | {
      type: typeof WORKSPACE_MATE_EMBED_OPEN_WORKSPACE;
      version: typeof WORKSPACE_MATE_EMBED_PROTOCOL_VERSION;
      instanceId: string;
      mateId: string;
      conversationId?: string;
    }
  | {
      type: typeof WORKSPACE_MATE_EMBED_CLOSE;
      version: typeof WORKSPACE_MATE_EMBED_PROTOCOL_VERSION;
      instanceId: string;
      mateId: string;
    }
  | {
      type: typeof WORKSPACE_MATE_EMBED_ERROR;
      version: typeof WORKSPACE_MATE_EMBED_PROTOCOL_VERSION;
      instanceId: string;
      mateId: string;
      code: string;
    };

export function normalizeWorkspaceMateEmbedConfigureMessage(
  value: unknown
): WorkspaceMateEmbedConfigureMessage {
  const source = record(value, "mate_embed_message_invalid");
  if (source.type !== WORKSPACE_MATE_EMBED_CONFIGURE || source.version !== WORKSPACE_MATE_EMBED_PROTOCOL_VERSION) {
    throw new Error("mate_embed_message_invalid");
  }
  const instanceId = boundedText(source.instanceId, 180, "mate_embed_instance_invalid");
  const mateId = normalizeWorkspaceMateChatIdentifier(
    boundedText(source.mateId, 180, "mate_id_invalid"),
    "mate_id_invalid"
  );
  const conversationId = source.conversationId === undefined
    ? undefined
    : normalizeWorkspaceMateChatIdentifier(
        boundedText(source.conversationId, 180, "conversation_id_invalid"),
        "conversation_id_invalid"
      );
  const environment = source.environment === undefined
    ? undefined
    : normalizeEmbedEnvironment(source.environment);
  const selection = source.selection === undefined
    ? undefined
    : currentWorkspaceMateCapabilitySelection(source.selection as WorkspaceMateCapabilitySelection);
  return {
    type: WORKSPACE_MATE_EMBED_CONFIGURE,
    version: WORKSPACE_MATE_EMBED_PROTOCOL_VERSION,
    instanceId,
    mateId,
    ...(conversationId ? { conversationId } : {}),
    ...(environment ? { environment } : {}),
    ...(selection ? { selection } : {})
  };
}

export function normalizeWorkspaceMateEmbedFrameMessage(value: unknown): WorkspaceMateEmbedFrameMessage {
  const source = record(value, "mate_embed_message_invalid");
  if (source.version !== WORKSPACE_MATE_EMBED_PROTOCOL_VERSION) throw new Error("mate_embed_message_invalid");
  const type = source.type;
  const instanceId = boundedText(source.instanceId, 180, "mate_embed_instance_invalid");
  const mateId = normalizeWorkspaceMateChatIdentifier(
    boundedText(source.mateId, 180, "mate_id_invalid"),
    "mate_id_invalid"
  );
  const base = { type, version: WORKSPACE_MATE_EMBED_PROTOCOL_VERSION, instanceId, mateId };
  if (type === WORKSPACE_MATE_EMBED_READY) return { ...base, type };
  if (type === WORKSPACE_MATE_EMBED_STATE) {
    if (source.state !== "loading" && source.state !== "ready" && source.state !== "error") {
      throw new Error("mate_embed_state_invalid");
    }
    return { ...base, type, state: source.state };
  }
  if (type === WORKSPACE_MATE_EMBED_CONVERSATION) {
    return {
      ...base,
      type,
      conversationId: normalizeWorkspaceMateChatIdentifier(
        boundedText(source.conversationId, 180, "conversation_id_invalid"),
        "conversation_id_invalid"
      )
    };
  }
  if (type === WORKSPACE_MATE_EMBED_OPEN_WORKSPACE) {
    const conversationId = source.conversationId === undefined
      ? undefined
      : normalizeWorkspaceMateChatIdentifier(
          boundedText(source.conversationId, 180, "conversation_id_invalid"),
          "conversation_id_invalid"
        );
    return { ...base, type, ...(conversationId ? { conversationId } : {}) };
  }
  if (type === WORKSPACE_MATE_EMBED_CLOSE) return { ...base, type };
  if (type === WORKSPACE_MATE_EMBED_ERROR) {
    return { ...base, type, code: boundedText(source.code, 180, "mate_embed_error_invalid") };
  }
  throw new Error("mate_embed_message_invalid");
}

function boundedText(value: unknown, maximum: number, code: string) {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output || output.length > maximum || /[\u0000-\u001f\u007f]/.test(output)) throw new Error(code);
  return output;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

const SENSITIVE_ENVIRONMENT_KEY = /^(userId|ownerUserId|orgId|authorization|cookie|password|secret|token|credential|accessToken|refreshToken|scopes?|api[_-]?key|jwt|bearer|session(cookie|token|secret)|client[_-]?secret|private[_-]?key)$/i;

function normalizeEmbedEnvironment(value: unknown): WorkspaceMateEnvironmentContext {
  assertEnvironmentSize(value);
  rejectSensitiveEnvironmentKeys(value);
  const source = knownRecord(
    value,
    ["schemaVersion", "revision", "host", "location", "ancestry", "summary", "resolutionHints"],
    "mate_environment_invalid"
  );
  if (source.schemaVersion !== "workspace.mate-environment/v1") throw new Error("mate_environment_schema_invalid");
  if (!Number.isSafeInteger(source.revision) || Number(source.revision) < 1) {
    throw new Error("mate_environment_revision_invalid");
  }
  const host = knownRecord(source.host, ["appId", "surface", "instanceId"], "mate_environment_host_invalid");
  const location = knownRecord(source.location, ["kind", "ref", "route"], "mate_environment_location_invalid");
  const ancestry = source.ancestry === undefined
    ? undefined
    : boundedEnvironmentArray(source.ancestry, 8, "mate_environment_ancestry_invalid").map((coordinate) => {
        const item = knownRecord(coordinate, ["kind", "ref"], "mate_environment_ancestry_invalid");
        return {
          kind: environmentKind(item.kind, "mate_environment_ancestry_kind_invalid"),
          ref: boundedText(item.ref, 500, "mate_environment_ancestry_ref_invalid")
        };
      });
  const summarySource = source.summary === undefined
    ? undefined
    : knownRecord(source.summary, ["label", "description", "state", "facets"], "mate_environment_summary_invalid");
  const facetsSource = summarySource?.facets === undefined
    ? undefined
    : record(summarySource.facets, "mate_environment_facets_invalid");
  if (facetsSource && Object.keys(facetsSource).length > 32) throw new Error("mate_environment_facets_too_many");
  const facets = facetsSource ? Object.fromEntries(Object.entries(facetsSource).map(([key, child]) => {
    const normalizedKey = boundedText(key, 100, "mate_environment_facet_key_invalid");
    if (child !== null && typeof child !== "string" && typeof child !== "number" && typeof child !== "boolean") {
      throw new Error("mate_environment_facet_value_invalid");
    }
    if (typeof child === "number" && !Number.isFinite(child)) throw new Error("mate_environment_facet_value_invalid");
    if (typeof child === "string") boundedText(child, 300, "mate_environment_facet_value_invalid");
    return [normalizedKey, child];
  })) : undefined;
  const hints = source.resolutionHints === undefined
    ? undefined
    : boundedEnvironmentArray(source.resolutionHints, 16, "mate_environment_hints_invalid").map((hint) => {
        const item = knownRecord(hint, ["capability", "bindingId", "purpose"], "mate_environment_hint_invalid");
        return compactEnvironment({
          capability: environmentKind(item.capability, "mate_environment_hint_capability_invalid"),
          bindingId: optionalEnvironmentText(item.bindingId, 180, "mate_environment_hint_binding_id_invalid"),
          purpose: optionalEnvironmentText(item.purpose, 300, "mate_environment_hint_purpose_invalid")
        });
      });
  const route = optionalEnvironmentText(location.route, 2_000, "mate_environment_location_route_invalid");
  if (route && (!route.startsWith("/") || route.startsWith("//"))) throw new Error("mate_environment_location_route_invalid");
  const output: WorkspaceMateEnvironmentContext = {
    schemaVersion: "workspace.mate-environment/v1",
    revision: Number(source.revision),
    host: compactEnvironment({
      appId: boundedText(host.appId, 180, "mate_environment_host_app_id_invalid"),
      surface: boundedText(host.surface, 80, "mate_environment_host_surface_invalid"),
      instanceId: optionalEnvironmentText(host.instanceId, 180, "mate_environment_host_instance_id_invalid")
    }) as WorkspaceMateEnvironmentContext["host"],
    location: compactEnvironment({
      kind: environmentKind(location.kind, "mate_environment_location_kind_invalid"),
      ref: boundedText(location.ref, 500, "mate_environment_location_ref_invalid"),
      route
    }) as WorkspaceMateEnvironmentContext["location"],
    ...(ancestry ? { ancestry } : {}),
    ...(summarySource ? {
      summary: compactEnvironment({
        label: optionalEnvironmentText(summarySource.label, 300, "mate_environment_summary_label_invalid"),
        description: optionalEnvironmentText(summarySource.description, 1_000, "mate_environment_summary_description_invalid"),
        state: optionalEnvironmentText(summarySource.state, 100, "mate_environment_summary_state_invalid"),
        facets
      })
    } : {}),
    ...(hints ? { resolutionHints: hints } : {})
  };
  assertEnvironmentSize(output);
  return output;
}

function knownRecord(value: unknown, keys: string[], code: string) {
  const source = record(value, code);
  if (Object.keys(source).some((key) => !keys.includes(key))) throw new Error(`${code}_field_unknown`);
  return source;
}

function boundedEnvironmentArray(value: unknown, maximum: number, code: string) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(code);
  return value;
}

function optionalEnvironmentText(value: unknown, maximum: number, code: string) {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedText(value, maximum, code);
}

function environmentKind(value: unknown, code: string) {
  const output = boundedText(value, 80, code);
  if (!/^[A-Za-z][A-Za-z0-9_.-]+$/.test(output)) throw new Error(code);
  return output;
}

function compactEnvironment<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as T;
}

function assertEnvironmentSize(value: unknown) {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("mate_environment_invalid");
  }
  if (!encoded || new TextEncoder().encode(encoded).byteLength > 16 * 1024) {
    throw new Error("mate_environment_size_invalid");
  }
}

function rejectSensitiveEnvironmentKeys(value: unknown) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(rejectSensitiveEnvironmentKeys);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_ENVIRONMENT_KEY.test(key)) throw new Error("mate_environment_sensitive_field_forbidden");
    rejectSensitiveEnvironmentKeys(child);
  }
}
