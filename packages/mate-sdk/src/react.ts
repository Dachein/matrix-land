import { useAgent, type UseAgentOptions } from "agents/react";
import {
  useAgentChat,
  type UseAgentChatOptions
} from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createWorkspaceMateChatGrantManager,
  normalizeWorkspaceMateChatIdentifier,
  WorkspaceMateChatHostError,
  type WorkspaceMateAccessToken,
  type WorkspaceMateChatMode
} from "./chatGrant.js";
import {
  createWorkspaceMateAgentConnectionConfig,
  createWorkspaceMateChatTurnBody,
  createWorkspaceMateInitialMessagesLoader,
  createWorkspaceMateMountInstanceId,
  WORKSPACE_MATE_CHAT_TRANSPORT_POLICY,
  type WorkspaceMateCapabilitySelectionSource,
  type WorkspaceMateEnvironmentSource
} from "./chatHost.js";
import {
  WorkspaceMateConversationCache,
  WorkspaceMatePersistentConversationCache,
  type WorkspaceMateConversationCacheCoordinate
} from "./conversationCache.js";

const transcriptCache = new WorkspaceMateConversationCache();
const persistentTranscriptCache = new WorkspaceMatePersistentConversationCache();

export type WorkspaceMateAgentOptions<State> = Pick<
  UseAgentOptions<State>,
  "onConnectionError"
>;

export type WorkspaceMateChatOptions<
  State,
  ChatMessage extends UIMessage
> = Pick<
  UseAgentChatOptions<State, ChatMessage>,
  "onData" | "onError" | "onFinish" | "throttle"
>;

export type UseWorkspaceMateChatOptions<
  State = unknown,
  ChatMessage extends UIMessage = UIMessage
> = {
  accessToken: WorkspaceMateAccessToken;
  agentOptions?: WorkspaceMateAgentOptions<State>;
  chatOptions?: WorkspaceMateChatOptions<State, ChatMessage>;
  conversationId: string;
  environment: WorkspaceMateEnvironmentSource;
  fetch?: typeof fetch;
  grantRefreshSkewMs?: number;
  mode?: WorkspaceMateChatMode;
  /**
   * Stable opaque auth-session key. Never pass a bearer, email, or raw user ID.
   * Rotate this key whenever the authenticated principal changes.
   */
  principalKey: string;
  queryRefreshMs?: number;
  runtimeOrigin: string;
  /** Per-turn Resource/model selection. Environment remains semantic only. */
  selection?: WorkspaceMateCapabilitySelectionSource;
  mateId: string;
  /** Preview release coordinate; used only to isolate tab-memory cache keys. */
  releaseId?: string;
};

export type WorkspaceMateSendOptions = {
  continuationMessageId?: string;
  files?: Array<{
    filename: string;
    mediaType: string;
    type: "file";
    url: string;
  }>;
  messageId?: string;
};

export type WorkspaceMatePreparedUserMessage = { text: string } | {
  id?: string;
  parts: Array<
    | { text: string; type: "text" }
    | { filename: string; mediaType: string; type: "file"; url: string }
  >;
  role: "user";
};

/**
 * The Mate SDK owns the interactive connection. A Web application is only
 * a Host that supplies auth, the current Environment coordinate, and UI.
 *
 * Cloudflare async query resolution uses React Suspense. Mount this hook under
 * a Suspense boundary so the first protected grant can resolve before the
 * WebSocket is opened.
 */
export function useWorkspaceMateChat<
  State = unknown,
  ChatMessage extends UIMessage = UIMessage
>(options: UseWorkspaceMateChatOptions<State, ChatMessage>) {
  const environmentRef = useRef(options.environment);
  environmentRef.current = options.environment;
  const fetchRef = useRef(options.fetch);
  fetchRef.current = options.fetch;
  const selectionRef = useRef(options.selection);
  selectionRef.current = options.selection;
  const connectionQueryEpochRef = useRef<number | undefined>(undefined);
  if (connectionQueryEpochRef.current === undefined) {
    // React can retry an initial suspended render, so this key must be
    // deterministic for a short window rather than randomly generated. It
    // still rotates across later component mounts before a cached connection
    // grant can become stale.
    connectionQueryEpochRef.current = Math.floor(Date.now() / 120_000);
  }
  const mountInstanceIdRef = useRef<string | undefined>(undefined);
  if (!mountInstanceIdRef.current) {
    mountInstanceIdRef.current = createWorkspaceMateMountInstanceId();
  }
  const cacheCoordinate = useMemo<WorkspaceMateConversationCacheCoordinate>(() => ({
    conversationId: options.conversationId,
    mode: options.mode ?? "live",
    principalKey: options.principalKey,
    releaseId: options.releaseId,
    mateId: options.mateId
  }), [options.conversationId, options.mode, options.principalKey, options.releaseId, options.mateId]);
  const cachedMessages = useMemo(
    () => transcriptCache.read<ChatMessage>(cacheCoordinate)
      ?? persistentTranscriptCache.read<ChatMessage>(cacheCoordinate),
    [cacheCoordinate]
  );
  const cachedBaselineRef = useRef<ChatMessage[] | undefined>(cachedMessages);
  const [hydrationError, setHydrationError] = useState<Error>();
  const [hydrationSource, setHydrationSource] = useState<"cache" | "server">(cachedMessages ? "cache" : "server");

  const grantManager = useMemo(() => createWorkspaceMateChatGrantManager({
    accessToken: options.accessToken,
    conversationId: options.conversationId,
    fetch: options.fetch,
    mode: options.mode,
    principalKey: options.principalKey,
    refreshSkewMs: options.grantRefreshSkewMs,
    runtimeOrigin: options.runtimeOrigin,
    mateId: options.mateId
  }), [
    options.conversationId,
    options.grantRefreshSkewMs,
    options.mode,
    options.principalKey,
    options.runtimeOrigin,
    options.mateId
  ]);
  grantManager.updateCredentials({
    accessToken: options.accessToken,
    fetch: options.fetch
  });

  const connection = useMemo(() => createWorkspaceMateAgentConnectionConfig({
    conversationId: options.conversationId,
    grantManager,
    mode: options.mode,
    queryRefreshMs: options.queryRefreshMs,
    runtimeOrigin: options.runtimeOrigin,
    mateId: options.mateId
  }), [
    grantManager,
    options.conversationId,
    options.mode,
    options.queryRefreshMs,
    options.runtimeOrigin,
    options.mateId
  ]);
  const connectionQueryDeps = useMemo(() => [
    ...connection.queryDeps,
    connectionQueryEpochRef.current!
  ], [connection]);
  const authoritativeMessagesLoader = useMemo(() => createWorkspaceMateInitialMessagesLoader<ChatMessage>({
    fetch: () => fetchRef.current,
    grantManager
  }), [grantManager]);
  const getInitialMessages = useMemo(() => cachedMessages ? null : async (request: Parameters<typeof authoritativeMessagesLoader>[0]) => {
    const messages = await authoritativeMessagesLoader(request);
    transcriptCache.write(cacheCoordinate, messages);
    persistentTranscriptCache.write(cacheCoordinate, messages);
    return messages;
  }, [authoritativeMessagesLoader, cacheCoordinate, cachedMessages]);

  const agent = useAgent<State>({
    ...connection,
    onConnectionError: options.agentOptions?.onConnectionError,
    queryDeps: connectionQueryDeps
  });
  const chat = useAgentChat<State, ChatMessage>({
    ...WORKSPACE_MATE_CHAT_TRANSPORT_POLICY,
    agent,
    body: () => createWorkspaceMateChatTurnBody({
      environment: environmentRef.current,
      grantManager,
      mountInstanceId: mountInstanceIdRef.current!,
      selection: selectionRef.current
    }),
    getInitialMessages,
    ...(cachedMessages ? { messages: cachedMessages } : {}),
    prepareSendMessagesRequest: ({ messages }) => ({ body: { messages: messages.slice(-1), transcriptMode: "server" } }),
    onData: options.chatOptions?.onData,
    onError: options.chatOptions?.onError,
    onFinish: options.chatOptions?.onFinish,
    throttle: options.chatOptions?.throttle
  });

  useEffect(() => {
    transcriptCache.write(cacheCoordinate, chat.messages);
    const timer = setTimeout(() => persistentTranscriptCache.write(cacheCoordinate, chat.messages), 500);
    return () => clearTimeout(timer);
  }, [cacheCoordinate, chat.messages]);

  useEffect(() => {
    if (!cachedBaselineRef.current) return;
    let active = true;
    const rawUrl = agent.getHttpUrl();
    const url = rawUrl ? new URL(rawUrl) : undefined;
    url?.searchParams.delete("_pk");
    void authoritativeMessagesLoader({
      agent: agent.agent,
      name: agent.name,
      url: url?.toString()
    }).then((authoritative) => {
      if (!active) return;
      chat.setMessages((current) => {
        const reconciled = reconcileCachedConversation(
          authoritative,
          current,
          cachedBaselineRef.current ?? []
        );
        // Cache the reconciled view immediately so a navigation that happens
        // before React's messages effect still retains local streaming work.
        transcriptCache.write(cacheCoordinate, reconciled);
        return reconciled;
      });
      setHydrationError(undefined);
      setHydrationSource("server");
    }).catch((error) => {
      if (active) setHydrationError(error instanceof Error ? error : new Error("mate_chat_hydration_failed"));
    });
    return () => { active = false; };
  }, [agent, authoritativeMessagesLoader, cacheCoordinate]);

  return {
    clearError: chat.clearError,
    connectionError: chat.connectionError,
    error: chat.error,
    id: chat.id,
    hydrationError,
    hydrationSource,
    isRecovering: chat.isRecovering,
    isServerStreaming: chat.isServerStreaming,
    isStreaming: chat.isStreaming,
    messages: chat.messages,
    resumeStream: () => chat.resumeStream(),
    sendMessage: (text: string, sendOptions: WorkspaceMateSendOptions = {}) => chat.sendMessage(
      prepareWorkspaceMateUserMessage(text, sendOptions) as Parameters<typeof chat.sendMessage>[0],
      sendOptions.continuationMessageId ? { body: { continuationMessageId: normalizeWorkspaceMateChatIdentifier(sendOptions.continuationMessageId, "mate_chat_continuation_invalid") } } : undefined
    ),
    status: chat.status,
    stop: chat.stop
  };
}

export function clearWorkspaceMateConversationCache(
  coordinate?: WorkspaceMateConversationCacheCoordinate
) {
  transcriptCache.clear(coordinate);
  persistentTranscriptCache.clear(coordinate);
}

export function clearWorkspaceMateConversationCacheScope(
  scope: Omit<WorkspaceMateConversationCacheCoordinate, "conversationId">
) {
  transcriptCache.clearScope(scope);
  persistentTranscriptCache.clearScope(scope);
}

/**
 * Reads a cloned local transcript for optimistic Host navigation. Runtime
 * sessions and chat grants are never cached here.
 */
export function readWorkspaceMateConversationCache<ChatMessage extends UIMessage>(
  coordinate: WorkspaceMateConversationCacheCoordinate
) {
  return transcriptCache.read<ChatMessage>(coordinate)
    ?? persistentTranscriptCache.read<ChatMessage>(coordinate);
}

export function reconcileCachedConversation<ChatMessage extends UIMessage>(
  authoritative: ChatMessage[],
  current: ChatMessage[],
  baseline: ChatMessage[]
) {
  const baselineById = new Map(baseline.map((message) => [message.id, message]));
  const currentById = new Map(current.map((message) => [message.id, message]));
  const authoritativeIds = new Set(authoritative.map((message) => message.id));
  const result = authoritative.map((message) => {
    const local = currentById.get(message.id);
    const original = baselineById.get(message.id);
    return local && original && !sameMessage(local, original) ? local : message;
  });
  for (const message of current) {
    if (authoritativeIds.has(message.id)) continue;
    const original = baselineById.get(message.id);
    if (!original || !sameMessage(message, original)) result.push(message);
  }
  return result;
}

function sameMessage(left: UIMessage, right: UIMessage) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * AI SDK's `messageId` field means "replace an existing user message". A
 * Workspace caller-supplied ID identifies a new append, so represent it as the
 * new UIMessage's `id` instead of forwarding it as AI SDK `messageId`.
 */
export function prepareWorkspaceMateUserMessage(
  text: string,
  options: WorkspaceMateSendOptions = {}
): WorkspaceMatePreparedUserMessage {
  const content = normalizeTextMessage(text);
  const files = normalizeMessageFiles(options.files);
  if (!options.messageId && files.length === 0) return { text: content };
  return {
    ...(options.messageId ? { id: normalizeMessageId(options.messageId) } : {}),
    parts: [{ text: content, type: "text" }, ...files],
    role: "user"
  };
}

function normalizeMessageFiles(value: WorkspaceMateSendOptions["files"]) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) {
    throw new WorkspaceMateChatHostError("mate_chat_message_files_invalid", 422);
  }
  return value.map((file) => {
    const filename = typeof file?.filename === "string" ? file.filename.trim() : "";
    const mediaType = typeof file?.mediaType === "string" ? file.mediaType.trim().toLowerCase() : "";
    const url = typeof file?.url === "string" ? file.url.trim() : "";
    if (
      file?.type !== "file"
      || !filename
      || filename.length > 180
      || /[\u0000-\u001f\u007f/\\]/.test(filename)
      || !/^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/i.test(mediaType)
      || !/^\/api\/workspace-files\/[A-Za-z0-9_.%-]{1,540}\/raw$/.test(url)
    ) throw new WorkspaceMateChatHostError("mate_chat_message_files_invalid", 422);
    return { filename, mediaType, type: "file" as const, url };
  });
}

function normalizeTextMessage(value: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new WorkspaceMateChatHostError("mate_chat_message_text_required", 422);
  if (text.length > 12_000) throw new WorkspaceMateChatHostError("mate_chat_message_too_large", 413);
  return text;
}

function normalizeMessageId(value: string) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(id)) {
    throw new WorkspaceMateChatHostError("mate_chat_message_id_invalid", 422);
  }
  return id;
}
