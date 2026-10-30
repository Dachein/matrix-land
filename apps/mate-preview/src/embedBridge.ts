import {
  WORKSPACE_MATE_EMBED_CONVERSATION,
  WORKSPACE_MATE_EMBED_CLOSE,
  WORKSPACE_MATE_EMBED_ERROR,
  WORKSPACE_MATE_EMBED_OPEN_WORKSPACE,
  WORKSPACE_MATE_EMBED_PROTOCOL_VERSION,
  WORKSPACE_MATE_EMBED_READY,
  WORKSPACE_MATE_EMBED_STATE,
  normalizeWorkspaceMateEmbedConfigureMessage,
  type WorkspaceMateEmbedConfigureMessage,
  type WorkspaceMateEmbedFrameMessage
} from "../../../packages/mate-sdk/dist/embedProtocol.js";

export type MateEmbedFrameBridge = {
  close(): void;
  conversation(conversationId: string): void;
  error(code: string): void;
  openWorkspace(conversationId?: string): void;
  requestClose(): void;
  state(state: "loading" | "ready" | "error"): void;
};

export function mergeMateEmbedConfiguration(
  current: WorkspaceMateEmbedConfigureMessage | undefined,
  next: WorkspaceMateEmbedConfigureMessage
): WorkspaceMateEmbedConfigureMessage {
  return current ? { ...current, ...next } : next;
}

export function connectMateEmbedFrame(input: {
  instanceId: string;
  mateId: string;
  onConfigure: (configuration: WorkspaceMateEmbedConfigureMessage) => void;
  document?: Pick<Document, "referrer">;
  window?: Window;
}): MateEmbedFrameBridge {
  const frameWindow = input.window ?? window;
  const frameDocument = input.document ?? document;
  let parentOrigin = referrerOrigin(frameDocument.referrer);

  const post = (message: WorkspaceMateEmbedFrameMessage) => {
    if (!parentOrigin || frameWindow.parent === frameWindow) return;
    frameWindow.parent.postMessage(message, parentOrigin);
  };
  const base = {
    instanceId: input.instanceId,
    mateId: input.mateId,
    version: WORKSPACE_MATE_EMBED_PROTOCOL_VERSION
  } as const;
  const onMessage = (event: MessageEvent) => {
    if (event.source !== frameWindow.parent || frameWindow.parent === frameWindow) return;
    if (parentOrigin && event.origin !== parentOrigin) return;
    let configuration: WorkspaceMateEmbedConfigureMessage;
    try {
      configuration = normalizeWorkspaceMateEmbedConfigureMessage(event.data);
    } catch {
      return;
    }
    if (configuration.instanceId !== input.instanceId || configuration.mateId !== input.mateId) return;
    if (!parentOrigin) {
      parentOrigin = allowedParentOrigin(event.origin);
      if (!parentOrigin) return;
    }
    input.onConfigure(configuration);
  };

  frameWindow.addEventListener("message", onMessage);
  post({ ...base, type: WORKSPACE_MATE_EMBED_READY });

  return {
    close() {
      frameWindow.removeEventListener("message", onMessage);
    },
    conversation(conversationId) {
      post({ ...base, conversationId, type: WORKSPACE_MATE_EMBED_CONVERSATION });
    },
    error(code) {
      post({ ...base, code, type: WORKSPACE_MATE_EMBED_ERROR });
    },
    openWorkspace(conversationId) {
      post({ ...base, ...(conversationId ? { conversationId } : {}), type: WORKSPACE_MATE_EMBED_OPEN_WORKSPACE });
    },
    requestClose() {
      post({ ...base, type: WORKSPACE_MATE_EMBED_CLOSE });
    },
    state(state) {
      post({ ...base, state, type: WORKSPACE_MATE_EMBED_STATE });
    }
  };
}

function referrerOrigin(value: string) {
  if (!value) return undefined;
  try {
    return allowedParentOrigin(new URL(value).origin);
  } catch {
    return undefined;
  }
}

function allowedParentOrigin(value: string) {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return undefined;
    if (url.origin !== value) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
