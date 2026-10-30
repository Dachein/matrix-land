import type {
  WorkspaceMateEnvironmentContext,
  WorkspaceMateEnvironmentController
} from "@frontier-workspace/mate";
import {
  WorkspaceMateChatHostError,
  normalizeWorkspaceMateChatIdentifier,
  normalizeWorkspaceMateChatMode,
  normalizeWorkspaceMateRuntimeOrigin,
  type WorkspaceMateChatGrantManager,
  type WorkspaceMateChatMode
} from "./chatGrant.js";

export type WorkspaceMateEnvironmentSource =
  | WorkspaceMateEnvironmentContext
  | WorkspaceMateEnvironmentController
  | (() => WorkspaceMateEnvironmentContext | undefined);

export type WorkspaceMateCapabilitySelection = {
  /** Selection only narrows the Knowledge bindings declared by the Release. */
  knowledgeServiceIds?: string[];
  /** Selection only narrows the App MCP bindings declared by the Release. */
  appIds?: string[];
  /** The Runtime accepts this only when it is in the Release model whitelist. */
  modelId?: string;
};

export type WorkspaceMateCapabilitySelectionSource =
  | WorkspaceMateCapabilitySelection
  | (() => WorkspaceMateCapabilitySelection | undefined);

export const WORKSPACE_MATE_CHAT_TRANSPORT_POLICY = Object.freeze({
  cancelOnClientAbort: false,
  resume: true,
  syncMessagesToServer: false
} as const);

// The async query is needed only to authorize a WebSocket connection. The
// Agents React adapter suspends the rendered tree whenever this cache expires,
// so a short TTL visibly replaces an already hydrated conversation. Actual
// turn grants are still refreshed by WorkspaceMateChatGrantManager, and a
// socket close invalidates the Agents query cache before reconnecting.
export const WORKSPACE_MATE_CONNECTION_QUERY_CACHE_TTL_MS = 2_000_000_000;

export type WorkspaceMateAgentConnectionOptions = {
  conversationId: string;
  grantManager: Pick<WorkspaceMateChatGrantManager, "dependencyKey" | "get">;
  mode?: WorkspaceMateChatMode;
  queryRefreshMs?: number;
  runtimeOrigin: string;
  mateId: string;
};

export type WorkspaceMateAgentConnectionConfig = {
  agent: "MateChatAgent";
  basePath: string;
  cacheTtl: number;
  host: string;
  name: string;
  protocol: "ws" | "wss";
  query: () => Promise<{ grant: string }>;
  queryDeps: readonly string[];
};

export function createWorkspaceMateAgentConnectionConfig(
  options: WorkspaceMateAgentConnectionOptions
): WorkspaceMateAgentConnectionConfig {
  const runtimeOrigin = normalizeWorkspaceMateRuntimeOrigin(options.runtimeOrigin);
  const runtimeUrl = new URL(runtimeOrigin);
  const mateId = normalizeWorkspaceMateChatIdentifier(options.mateId, "mate_id_invalid");
  const conversationId = normalizeWorkspaceMateChatIdentifier(options.conversationId, "conversation_id_invalid");
  const mode = normalizeWorkspaceMateChatMode(options.mode);
  const cacheTtl = boundedQueryRefresh(
    options.queryRefreshMs ?? WORKSPACE_MATE_CONNECTION_QUERY_CACHE_TTL_MS
  );
  const basePath = [
    "v1",
    ...(mode === "preview" ? ["owner-test"] : []),
    "mates",
    encodeURIComponent(mateId),
    "conversations",
    encodeURIComponent(conversationId),
    "chat"
  ].join("/");
  const addressKey = normalizeGrantDependencyKey(options.grantManager.dependencyKey);
  return {
    agent: "MateChatAgent",
    basePath,
    cacheTtl,
    host: runtimeUrl.host,
    name: addressKey,
    protocol: runtimeUrl.protocol === "https:" ? "wss" : "ws",
    query: async () => ({ grant: (await options.grantManager.get()).grant }),
    queryDeps: [
      runtimeOrigin,
      mateId,
      conversationId,
      mode,
      options.grantManager.dependencyKey
    ]
  };
}

export type WorkspaceMateInitialMessagesRequest = {
  agent: string;
  name: string;
  url?: string;
};

export type WorkspaceMateInitialMessagesLoaderOptions = {
  /** Resolve at request time so an inline Host fetch wrapper can be replaced. */
  fetch?: () => typeof globalThis.fetch | undefined;
  grantManager: Pick<WorkspaceMateChatGrantManager, "get" | "invalidate">;
};

/**
 * Create the server-authoritative transcript loader used by the React adapter.
 * Unlike the upstream default, authorization and malformed responses fail
 * closed. One stale-grant 401 is retried with a freshly issued grant.
 */
export function createWorkspaceMateInitialMessagesLoader<ChatMessage>(
  options: WorkspaceMateInitialMessagesLoaderOptions
) {
  return async (request: WorkspaceMateInitialMessagesRequest): Promise<ChatMessage[]> => {
    const messagesUrl = normalizeInitialMessagesUrl(request.url);
    const allMessages: ChatMessage[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    while (true) {
      let response = await fetchInitialMessages(messagesUrl, options.fetch);
      if (response.status === 401) {
        options.grantManager.invalidate();
        const refreshed = await options.grantManager.get({ forceRefresh: true });
        messagesUrl.searchParams.set("grant", refreshed.grant);
        response = await fetchInitialMessages(messagesUrl, options.fetch);
      }
      if (!response.ok) throw await initialMessagesResponseError(response);
      const nextCursor = response.headers.get("X-Workspace-Chat-Next-Cursor");
      const page = await parseInitialMessages<ChatMessage>(response);
      for (const message of page) {
        const id = (message as { id: string }).id;
        if (seenIds.has(id)) throw new WorkspaceMateChatHostError("mate_chat_initial_messages_response_invalid", 502);
        seenIds.add(id);
      }
      allMessages.push(...page);
      if (!nextCursor) return allMessages;
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(nextCursor) || seenCursors.has(nextCursor) || (page.at(-1) as { id?: string } | undefined)?.id !== nextCursor) {
        throw new WorkspaceMateChatHostError("mate_chat_initial_messages_response_invalid", 502);
      }
      seenCursors.add(nextCursor);
      messagesUrl.searchParams.set("cursor", nextCursor);
    }
  };
}

export async function createWorkspaceMateChatTurnBody(options: {
  environment: WorkspaceMateEnvironmentSource;
  grantManager: Pick<WorkspaceMateChatGrantManager, "get">;
  mountInstanceId: string;
  selection?: WorkspaceMateCapabilitySelectionSource;
}) {
  const [grant, environment] = await Promise.all([
    options.grantManager.get(),
    Promise.resolve(currentEnvironment(options.environment))
  ]);
  return {
    chatGrant: grant.grant,
    environment: withMountInstance(environment, options.mountInstanceId),
    ...(options.selection ? { selection: currentWorkspaceMateCapabilitySelection(options.selection) } : {})
  };
}

export function currentWorkspaceMateCapabilitySelection(
  source: WorkspaceMateCapabilitySelectionSource
): WorkspaceMateCapabilitySelection {
  const value = typeof source === "function" ? source() : source;
  if (!value) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceMateChatHostError("mate_capability_selection_invalid", 400);
  }
  const knowledgeServiceIds = capabilityIds(value.knowledgeServiceIds, 12);
  const appIds = capabilityIds(value.appIds, 32);
  const modelId = value.modelId === undefined
    ? undefined
    : capabilityId(value.modelId, "mate_model_selection_invalid");
  return {
    ...(knowledgeServiceIds ? { knowledgeServiceIds } : {}),
    ...(appIds ? { appIds } : {}),
    ...(modelId ? { modelId } : {})
  };
}

export function createWorkspaceMateMountInstanceId(randomUUID: () => string = () => crypto.randomUUID()) {
  return normalizeMountInstanceId(`tm3-mount-${randomUUID()}`);
}

export function currentWorkspaceMateEnvironment(
  source: WorkspaceMateEnvironmentSource
): WorkspaceMateEnvironmentContext {
  return currentEnvironment(source);
}

function currentEnvironment(source: WorkspaceMateEnvironmentSource) {
  const value = typeof source === "function"
    ? source()
    : hasCurrent(source)
      ? source.current()
      : source;
  if (!value) throw new WorkspaceMateChatHostError("mate_environment_unavailable", 409);
  try {
    return structuredClone(value);
  } catch {
    throw new WorkspaceMateChatHostError("mate_environment_invalid", 400);
  }
}

function hasCurrent(
  value: WorkspaceMateEnvironmentContext | WorkspaceMateEnvironmentController
): value is WorkspaceMateEnvironmentController {
  return typeof (value as Partial<WorkspaceMateEnvironmentController>).current === "function";
}

function withMountInstance(
  environment: WorkspaceMateEnvironmentContext,
  mountInstanceId: string
): WorkspaceMateEnvironmentContext {
  return {
    ...environment,
    host: {
      ...environment.host,
      instanceId: normalizeMountInstanceId(mountInstanceId)
    }
  };
}

function normalizeMountInstanceId(value: string) {
  const identifier = typeof value === "string" ? value.trim() : "";
  if (!identifier || identifier.length > 180 || /[\u0000-\u001f\u007f]/.test(identifier)) {
    throw new WorkspaceMateChatHostError("mate_environment_mount_instance_id_invalid", 400);
  }
  return identifier;
}

function capabilityIds(value: unknown, maximumItems: number) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new WorkspaceMateChatHostError("mate_capability_selection_invalid", 400);
  }
  const result = value.map((item) => capabilityId(item, "mate_capability_selection_invalid"));
  if (new Set(result).size !== result.length) {
    throw new WorkspaceMateChatHostError("mate_capability_selection_invalid", 400);
  }
  return result;
}

function capabilityId(value: unknown, code: string) {
  const identifier = typeof value === "string" ? value.trim() : "";
  if (!identifier || identifier.length > 180 || /[\u0000-\u001f\u007f]/.test(identifier)) {
    throw new WorkspaceMateChatHostError(code, 400);
  }
  return identifier;
}

function boundedQueryRefresh(value: number) {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > WORKSPACE_MATE_CONNECTION_QUERY_CACHE_TTL_MS) {
    throw new WorkspaceMateChatHostError("mate_chat_query_refresh_invalid", 400);
  }
  return value;
}

function normalizeGrantDependencyKey(value: string) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!/^workspace-chat-resource-v1-[0-9a-f]{32}$/.test(key)) {
    throw new WorkspaceMateChatHostError("mate_chat_resource_key_invalid", 400);
  }
  return key;
}

function normalizeInitialMessagesUrl(value: string | undefined) {
  try {
    if (!value) throw new Error("missing_url");
    const source = new URL(value);
    if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) {
      throw new Error("invalid_url");
    }
    const grant = source.searchParams.get("grant");
    if (!grant || grant.length > 8_192 || /[\u0000-\u001f\u007f]/.test(grant)) {
      throw new Error("invalid_grant");
    }
    source.pathname = `${source.pathname.replace(/\/$/, "")}/get-messages`;
    source.search = "";
    source.hash = "";
    source.searchParams.set("grant", grant);
    return source;
  } catch {
    throw new WorkspaceMateChatHostError("mate_chat_initial_messages_url_invalid", 500);
  }
}

async function fetchInitialMessages(
  url: URL,
  resolveFetch: WorkspaceMateInitialMessagesLoaderOptions["fetch"]
) {
  try {
    const fetcher = resolveFetch?.() ?? globalThis.fetch;
    if (typeof fetcher !== "function") throw new Error("fetch_unavailable");
    return await fetcher(url, {
      headers: { accept: "application/json" },
      method: "GET"
    });
  } catch (error) {
    if (error instanceof WorkspaceMateChatHostError) throw error;
    throw new WorkspaceMateChatHostError("mate_chat_initial_messages_unavailable", 503);
  }
}

async function initialMessagesResponseError(response: Response) {
  const text = await response.text().catch(() => "");
  let code = "mate_chat_initial_messages_request_failed";
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof payload.error === "string"
      && /^[a-z][a-z0-9_]{2,95}$/.test(payload.error)
    ) code = payload.error;
  } catch {
    // A non-JSON error is still a typed, fail-closed Host error.
  }
  return new WorkspaceMateChatHostError(code, response.status, {
    responseStatus: response.status
  });
}

async function parseInitialMessages<ChatMessage>(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text || text.length > 4_000_000) {
    throw new WorkspaceMateChatHostError("mate_chat_initial_messages_response_invalid", 502);
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) throw new Error("messages_not_array");
    const messageIds = new Set<string>();
    for (const candidate of value) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("message_not_object");
      }
      const message = candidate as Record<string, unknown>;
      if (
        typeof message.id !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(message.id)
        || messageIds.has(message.id)
        || !["assistant", "system", "user"].includes(String(message.role))
        || !Array.isArray(message.parts)
      ) throw new Error("message_envelope_invalid");
      messageIds.add(message.id);
      for (const candidatePart of message.parts) {
        if (!candidatePart || typeof candidatePart !== "object" || Array.isArray(candidatePart)) {
          throw new Error("message_part_not_object");
        }
        const partType = (candidatePart as Record<string, unknown>).type;
        if (
          typeof partType !== "string"
          || !partType
          || partType !== partType.trim()
          || partType.length > 180
          || /[\u0000-\u001f\u007f]/.test(partType)
        ) throw new Error("message_part_type_invalid");
      }
    }
    return value as ChatMessage[];
  } catch {
    throw new WorkspaceMateChatHostError("mate_chat_initial_messages_response_invalid", 502);
  }
}
