import {
  fetchMcpConnectionStatus,
  type McpConnectionStatus
} from "../components/McpConnectionModal";

const MCP_CONNECTION_STATUS_SESSION_KEY = "workspace-ai:mcp-connection-status:v1";
const MCP_CONNECTION_STATUS_MAX_AGE_MS = 2 * 60 * 1000;

type McpConnectionStatusCacheEntry = {
  cachedAt: number;
  status: McpConnectionStatus;
  userId: string;
};

let activeUserId = "";
let memoryEntry: McpConnectionStatusCacheEntry | undefined;
let pendingStatus: Promise<McpConnectionStatus> | undefined;
let requestVersion = 0;

export function configureMcpConnectionStatusCache(userId: string) {
  const normalizedUserId = userId.trim();
  if (normalizedUserId === activeUserId) {
    return;
  }

  activeUserId = normalizedUserId;
  memoryEntry = readSessionEntry(normalizedUserId);
  pendingStatus = undefined;
  requestVersion += 1;
}

export function readCachedMcpConnectionStatus() {
  return memoryEntry?.userId === activeUserId ? memoryEntry : undefined;
}

export async function getCachedMcpConnectionStatus({
  forceRefresh = false,
  now = Date.now()
}: {
  forceRefresh?: boolean;
  now?: number;
} = {}) {
  const cached = readCachedMcpConnectionStatus();
  if (!forceRefresh && cached && now - cached.cachedAt < MCP_CONNECTION_STATUS_MAX_AGE_MS) {
    return cached.status;
  }

  if (!forceRefresh && pendingStatus) {
    return await pendingStatus;
  }

  const currentRequestVersion = requestVersion + 1;
  requestVersion = currentRequestVersion;
  const request = fetchMcpConnectionStatus()
    .then((status) => {
      if (requestVersion === currentRequestVersion) {
        cacheMcpConnectionStatus(status, now);
        return status;
      }
      return readCachedMcpConnectionStatus()?.status ?? status;
    })
    .finally(() => {
      if (pendingStatus === request) {
        pendingStatus = undefined;
      }
    });
  pendingStatus = request;
  return await request;
}

export function cacheMcpConnectionStatus(status: McpConnectionStatus, cachedAt = Date.now()) {
  if (!activeUserId) {
    return;
  }

  memoryEntry = { cachedAt, status, userId: activeUserId };
  writeSessionEntry({
    cachedAt,
    status: {
      activeCount: status.activeCount,
      connected: status.connected,
      connections: [],
      credentialState: status.credentialState,
      currentTaskAvailability: status.currentTaskAvailability,
      maxActiveConnections: status.maxActiveConnections
    },
    userId: activeUserId
  });
}

export function invalidateMcpConnectionStatusCache() {
  memoryEntry = undefined;
  pendingStatus = undefined;
  requestVersion += 1;
  removeSessionEntry();
}

export function notifyMcpConnectionsChanged() {
  invalidateMcpConnectionStatusCache();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("workspace:mcp-connections-changed"));
  }
}

function readSessionEntry(userId: string): McpConnectionStatusCacheEntry | undefined {
  if (!userId || typeof window === "undefined") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(MCP_CONNECTION_STATUS_SESSION_KEY) ?? "null") as Partial<McpConnectionStatusCacheEntry> | null;
    const status = parsed?.status;
    if (parsed?.userId !== userId) {
      removeSessionEntry();
      return undefined;
    }
    if (!Number.isFinite(parsed.cachedAt) || !status) {
      return undefined;
    }
    const activeCount = Math.max(0, Number(status.activeCount ?? 0));
    return {
      cachedAt: Number(parsed.cachedAt),
      status: {
        activeCount,
        connected: Boolean(status.connected) || activeCount > 0,
        connections: [],
        credentialState: status.credentialState === "idle_expired"
          ? "idle_expired"
          : activeCount > 0 ? "active" : "reauthorization_required",
        currentTaskAvailability: activeCount > 0 ? "reload_may_be_required" : "unavailable",
        maxActiveConnections: Math.max(1, Number(status.maxActiveConnections ?? 3))
      },
      userId
    };
  } catch {
    removeSessionEntry();
    return undefined;
  }
}

function writeSessionEntry(entry: McpConnectionStatusCacheEntry) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(MCP_CONNECTION_STATUS_SESSION_KEY, JSON.stringify(entry));
  } catch {
    // The in-memory cache remains available when browser storage is disabled or full.
  }
}

function removeSessionEntry() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(MCP_CONNECTION_STATUS_SESSION_KEY);
  } catch {
    // Storage may be disabled; clearing the in-memory entry is still sufficient.
  }
}
