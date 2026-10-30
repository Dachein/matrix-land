import { normalizeWorkspaceMateChatIdentifier } from "./chatGrant.js";
import type { WorkspaceMateCapabilitySelection } from "./chatHost.js";
import {
  WORKSPACE_MATE_EMBED_CONFIGURE,
  WORKSPACE_MATE_EMBED_CLOSE,
  WORKSPACE_MATE_EMBED_CONVERSATION,
  WORKSPACE_MATE_EMBED_OPEN_WORKSPACE,
  WORKSPACE_MATE_EMBED_PROTOCOL_VERSION,
  WORKSPACE_MATE_EMBED_READY,
  normalizeWorkspaceMateEmbedConfigureMessage,
  normalizeWorkspaceMateEmbedFrameMessage,
  type WorkspaceMateEmbedConfigureMessage,
  type WorkspaceMateEmbedFrameMessage
} from "./embedProtocol.js";
import type { WorkspaceMateEnvironmentContext } from "@frontier-workspace/mate";

export type WorkspaceMateEmbedOptions = {
  container: HTMLElement;
  mateId: string;
  /** Hosted Workspace Portal origin. Defaults to the current page origin. */
  origin?: string;
  conversationId?: string;
  /**
   * Optional browser-local cache for the opaque Conversation coordinate.
   * Scope the key to the authenticated principal and Mate. Credentials,
   * Environment, and capability selections are never persisted here.
   */
  conversationCache?: {
    key: string;
    storage?: Pick<Storage, "getItem" | "removeItem" | "setItem">;
  };
  environment?: WorkspaceMateEnvironmentContext;
  selection?: WorkspaceMateCapabilitySelection;
  title?: string;
  className?: string;
  onEvent?: (event: WorkspaceMateEmbedFrameMessage) => void;
  onClose?: () => void;
  onOpenWorkspace?: (url: string, conversationId?: string) => void;
};

export type WorkspaceMateEmbedUpdate = Pick<
  WorkspaceMateEmbedOptions,
  "conversationId" | "environment" | "selection"
>;

export type WorkspaceMateEmbedHandle = {
  readonly iframe: HTMLIFrameElement;
  destroy(): void;
  focus(): void;
  getConversationId(): string | undefined;
  openWorkspace(): void;
  update(next: WorkspaceMateEmbedUpdate): void;
};

export function mountWorkspaceMateEmbed(options: WorkspaceMateEmbedOptions): WorkspaceMateEmbedHandle {
  if (!options.container || typeof options.container.replaceChildren !== "function") {
    throw new Error("mate_embed_container_invalid");
  }
  const origin = normalizeEmbedOrigin(options.origin ?? window.location.origin);
  const mateId = normalizeWorkspaceMateChatIdentifier(options.mateId, "mate_id_invalid");
  const instanceId = `tm-embed-${crypto.randomUUID()}`;
  const conversationCache = normalizeConversationCache(options.conversationCache);
  const conversationId = options.conversationId ?? readCachedConversation(conversationCache);
  let current = normalizeWorkspaceMateEmbedConfigureMessage({
    type: WORKSPACE_MATE_EMBED_CONFIGURE,
    version: WORKSPACE_MATE_EMBED_PROTOCOL_VERSION,
    instanceId,
    mateId,
    ...(conversationId ? { conversationId } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.selection ? { selection: options.selection } : {})
  });
  const iframe = document.createElement("iframe");
  iframe.className = ["workspace-mate-embed-frame", options.className].filter(Boolean).join(" ");
  iframe.title = options.title?.trim() || "Workspace Mate";
  iframe.loading = "eager";
  iframe.referrerPolicy = "strict-origin";
  iframe.allow = "clipboard-write";
  iframe.src = workspaceMateEmbedUrl({
    conversationId: current.conversationId,
    instanceId,
    origin,
    mateId
  });
  iframe.dataset.mateId = mateId;
  iframe.dataset.embedInstance = instanceId;

  const sendConfiguration = () => {
    iframe.contentWindow?.postMessage(current, origin);
  };
  const onLoad = () => sendConfiguration();
  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || event.origin !== origin) return;
    let message: WorkspaceMateEmbedFrameMessage;
    try {
      message = normalizeWorkspaceMateEmbedFrameMessage(event.data);
    } catch {
      return;
    }
    if (message.instanceId !== instanceId || message.mateId !== mateId) return;
    if (message.type === WORKSPACE_MATE_EMBED_READY) sendConfiguration();
    if (message.type === WORKSPACE_MATE_EMBED_CONVERSATION) {
      current = { ...current, conversationId: message.conversationId };
      storeCachedConversation(conversationCache, message.conversationId);
    }
    if (message.type === WORKSPACE_MATE_EMBED_OPEN_WORKSPACE) {
      const conversationId = message.conversationId ?? current.conversationId;
      openWorkspace(options, origin, mateId, conversationId);
    }
    if (message.type === WORKSPACE_MATE_EMBED_CLOSE) options.onClose?.();
    options.onEvent?.(message);
  };
  iframe.addEventListener("load", onLoad);
  window.addEventListener("message", onMessage);
  options.container.replaceChildren(iframe);

  return {
    iframe,
    destroy() {
      iframe.removeEventListener("load", onLoad);
      window.removeEventListener("message", onMessage);
      iframe.remove();
    },
    focus() {
      iframe.focus();
    },
    getConversationId() {
      return current.conversationId;
    },
    openWorkspace() {
      openWorkspace(options, origin, mateId, current.conversationId);
    },
    update(next) {
      const patch = normalizeWorkspaceMateEmbedConfigureMessage({
        type: WORKSPACE_MATE_EMBED_CONFIGURE,
        version: WORKSPACE_MATE_EMBED_PROTOCOL_VERSION,
        instanceId,
        mateId,
        ...(next.conversationId !== undefined ? { conversationId: next.conversationId } : {}),
        ...(next.environment !== undefined ? { environment: next.environment } : {}),
        ...(next.selection !== undefined ? { selection: next.selection } : {})
      });
      current = normalizeWorkspaceMateEmbedConfigureMessage({ ...current, ...patch });
      iframe.contentWindow?.postMessage(patch, origin);
    }
  };
}

export function workspaceMateEmbedUrl(input: {
  origin: string;
  mateId: string;
  instanceId: string;
  conversationId?: string;
}) {
  const origin = normalizeEmbedOrigin(input.origin);
  const mateId = normalizeWorkspaceMateChatIdentifier(input.mateId, "mate_id_invalid");
  const instanceId = boundedText(input.instanceId, 180, "mate_embed_instance_invalid");
  const conversationId = input.conversationId
    ? normalizeWorkspaceMateChatIdentifier(input.conversationId, "conversation_id_invalid")
    : undefined;
  const url = new URL(`/mates/${encodeURIComponent(mateId)}/embed`, origin);
  url.searchParams.set("embedInstance", instanceId);
  if (conversationId) url.searchParams.set("conversation", conversationId);
  return url.toString();
}

export function workspaceMateWorkspaceUrl(input: {
  origin: string;
  mateId: string;
  conversationId?: string;
}) {
  const origin = normalizeEmbedOrigin(input.origin);
  const mateId = normalizeWorkspaceMateChatIdentifier(input.mateId, "mate_id_invalid");
  const url = new URL(`/mates/${encodeURIComponent(mateId)}`, origin);
  if (input.conversationId) {
    url.searchParams.set(
      "conversation",
      normalizeWorkspaceMateChatIdentifier(input.conversationId, "conversation_id_invalid")
    );
  }
  return url.toString();
}

function openWorkspace(
  options: WorkspaceMateEmbedOptions,
  origin: string,
  mateId: string,
  conversationId?: string
) {
  const url = workspaceMateWorkspaceUrl({ origin, mateId, conversationId });
  if (options.onOpenWorkspace) {
    options.onOpenWorkspace(url, conversationId);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function normalizeEmbedOrigin(value: string) {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:"))
      || url.pathname !== "/"
      || url.search
      || url.hash
      || url.username
      || url.password
    ) throw new Error("invalid_origin");
    return url.origin;
  } catch {
    throw new Error("mate_embed_origin_invalid");
  }
}

type NormalizedConversationCache = {
  key: string;
  storage?: Pick<Storage, "getItem" | "removeItem" | "setItem">;
};

function normalizeConversationCache(
  value: WorkspaceMateEmbedOptions["conversationCache"]
): NormalizedConversationCache | undefined {
  if (!value) return undefined;
  const key = boundedText(value.key, 300, "mate_embed_conversation_cache_key_invalid");
  return {
    key: `workspace.mate.embed.conversation:${key}`,
    storage: value.storage ?? browserLocalStorage()
  };
}

function browserLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readCachedConversation(cache: NormalizedConversationCache | undefined) {
  if (!cache?.storage) return undefined;
  try {
    const value = cache.storage.getItem(cache.key);
    return value
      ? normalizeWorkspaceMateChatIdentifier(value, "conversation_id_invalid")
      : undefined;
  } catch {
    try {
      cache.storage.removeItem(cache.key);
    } catch {
      // Managed browsers may disable browser storage entirely.
    }
    return undefined;
  }
}

function storeCachedConversation(cache: NormalizedConversationCache | undefined, conversationId: string) {
  if (!cache?.storage) return;
  try {
    cache.storage.setItem(
      cache.key,
      normalizeWorkspaceMateChatIdentifier(conversationId, "conversation_id_invalid")
    );
  } catch {
    // Conversation remains active even when browser storage is unavailable.
  }
}

function boundedText(value: unknown, maximum: number, code: string) {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output || output.length > maximum || /[\u0000-\u001f\u007f]/.test(output)) throw new Error(code);
  return output;
}

export type { WorkspaceMateEmbedConfigureMessage };
