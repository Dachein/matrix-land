import type { LiveDataSource, LiveSnapshot } from "./liveDataSource";
import {
  createSubscribeMessage,
  parsePortalLiveServerMessage,
  reducePortalLiveMessage
} from "./portalLiveProtocol";
import { PORTAL_LIVE_CURSOR_STORAGE_KEY } from "../../../../src/shared/portalLive";

type PortalWebSocketOptions = {
  initialSnapshot: LiveSnapshot;
  url: string;
  workspaceId: string;
};

const SOCKET_OPEN_TIMEOUT_MS = 12_000;
const SOCKET_STALE_TIMEOUT_MS = 95_000;

export function createPortalWebSocketLiveDataSource(options: PortalWebSocketOptions): LiveDataSource {
  let snapshot: LiveSnapshot = {
    ...options.initialSnapshot,
    connectionState: "connecting",
    cursor: options.initialSnapshot.cursor ?? readStoredCursor(options.workspaceId)
  };
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let watchdogTimer: number | undefined;
  let reconnectAttempt = 0;
  let stopped = true;
  const listeners = new Set<(snapshot: LiveSnapshot) => void>();

  function publish(nextSnapshot: LiveSnapshot) {
    snapshot = nextSnapshot;
    listeners.forEach((listener) => listener(snapshot));
  }

  function connect() {
    if (stopped || socket) {
      return;
    }

    publish({
      ...snapshot,
      connectionState: reconnectAttempt > 0 ? "reconnecting" : "connecting",
      error: undefined
    });

    try {
      const nextSocket = new WebSocket(portalLiveWebSocketUrl(options.url, options.workspaceId));
      socket = nextSocket;
      armWatchdog(nextSocket, SOCKET_OPEN_TIMEOUT_MS, "socket_open_timeout");
    } catch (error) {
      socket = undefined;
      scheduleReconnect(error instanceof Error ? error.message : "socket_create_failed");
      return;
    }

    const currentSocket = socket;

    currentSocket.addEventListener("open", () => {
      if (socket !== currentSocket || stopped) {
        return;
      }
      publish({ ...snapshot, connectionState: "connected", error: undefined });
      currentSocket.send(JSON.stringify(createSubscribeMessage(options.workspaceId, snapshot.cursor)));
      armWatchdog(currentSocket, SOCKET_STALE_TIMEOUT_MS, "socket_stale");
    });

    currentSocket.addEventListener("message", (event) => {
      if (socket !== currentSocket || stopped) {
        return;
      }
      armWatchdog(currentSocket, SOCKET_STALE_TIMEOUT_MS, "socket_stale");
      if (typeof event.data !== "string") {
        return;
      }

      const message = parsePortalLiveServerMessage(event.data);
      if (message) {
        reconnectAttempt = 0;
        const nextSnapshot = reducePortalLiveMessage(snapshot, message);
        if (nextSnapshot.cursor && nextSnapshot.cursor !== snapshot.cursor) {
          writeStoredCursor(options.workspaceId, nextSnapshot.cursor);
        }
        if (nextSnapshot !== snapshot) {
          publish(nextSnapshot);
        }
      }
    });

    currentSocket.addEventListener("error", () => {
      failSocket(currentSocket, "socket_error");
    });

    currentSocket.addEventListener("close", (event) => {
      if (socket !== currentSocket) {
        return;
      }
      clearWatchdog();
      socket = undefined;
      if (stopped || event.code === 1000) {
        publish({ ...snapshot, connectionState: "offline" });
        return;
      }
      scheduleReconnect(event.reason || `socket_closed_${event.code}`);
    });
  }

  function failSocket(currentSocket: WebSocket, error: string) {
    if (stopped || socket !== currentSocket) {
      return;
    }

    clearWatchdog();
    socket = undefined;
    try {
      currentSocket.close(4000, error);
    } catch {
      // A socket can reject close while its constructor is still failing.
    }
    scheduleReconnect(error);
  }

  function armWatchdog(currentSocket: WebSocket, delay: number, error: string) {
    clearWatchdog();
    watchdogTimer = window.setTimeout(() => {
      watchdogTimer = undefined;
      failSocket(currentSocket, error);
    }, delay);
  }

  function clearWatchdog() {
    if (watchdogTimer !== undefined) {
      window.clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  }

  function scheduleReconnect(error: string) {
    if (stopped || reconnectTimer !== undefined) {
      return;
    }

    reconnectAttempt += 1;
    publish({ ...snapshot, connectionState: "reconnecting", error });
    const baseDelay = Math.min(15_000, 800 * 2 ** Math.min(reconnectAttempt - 1, 5));
    const jitter = Math.floor(Math.random() * 240);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, baseDelay + jitter);
  }

  function start() {
    if (!stopped) {
      return;
    }
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true;
    clearWatchdog();
    if (reconnectTimer !== undefined) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    const currentSocket = socket;
    socket = undefined;
    currentSocket?.close(1000, "client_stop");
    publish({ ...snapshot, connectionState: "offline" });
  }

  return {
    getSnapshot: () => snapshot,
    start,
    stop,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export function portalLiveWebSocketUrl(rawUrl: string, workspaceId: string) {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("workspaceId", workspaceId);
    return url.toString();
  } catch {
    const separator = rawUrl.includes("?") ? "&" : "?";
    return `${rawUrl}${separator}workspaceId=${encodeURIComponent(workspaceId)}`;
  }
}

export function resolvePortalLiveWebSocketUrl(configuredUrl: string | undefined, location: Pick<Location, "host" | "protocol">) {
  const explicitUrl = configuredUrl?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  if (location.protocol !== "https:") {
    return undefined;
  }

  return `wss://${location.host}/live/v1/live`;
}

export function portalLiveCursorStorageKey(workspaceId: string) {
  return `${PORTAL_LIVE_CURSOR_STORAGE_KEY}:${workspaceId}`;
}

function readStoredCursor(workspaceId: string) {
  try {
    return window.localStorage?.getItem(portalLiveCursorStorageKey(workspaceId)) || undefined;
  } catch {
    return undefined;
  }
}

function writeStoredCursor(workspaceId: string, cursor: string) {
  try {
    window.localStorage?.setItem(portalLiveCursorStorageKey(workspaceId), cursor);
  } catch {
    // Storage can be unavailable in private browsing or test environments.
  }
}
