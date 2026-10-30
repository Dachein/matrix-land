import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type GroupUsage = {
  requestCount: number;
  startDate: string;
  totalTokens: number;
  updatedAt: string;
};

type GroupUsageState = {
  error: boolean;
  loading: boolean;
  usage?: GroupUsage;
};

type OwnedGroupUsageState = GroupUsageState & {
  userId: string;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

type CachedGroupUsage = {
  cachedAt: number;
  usage: GroupUsage;
  userId: string;
};

export type GroupUsageSnapshot = Pick<CachedGroupUsage, "cachedAt" | "usage">;

export const GROUP_USAGE_REFRESH_MS = 5 * 60 * 1000;
export const GROUP_USAGE_REQUEST_TIMEOUT_MS = 10 * 1000;
export const GROUP_USAGE_SESSION_KEY = "workspace-ai:group-usage:v1";

export function useGroupUsage(userId: string): GroupUsageState {
  const normalizedUserId = userId.trim();
  const initialSnapshot = useMemo(
    () => readCachedGroupUsageSnapshot(normalizedUserId),
    [normalizedUserId]
  );
  const [state, setState] = useState<OwnedGroupUsageState>(() => ({
    error: false,
    loading: !initialSnapshot,
    userId: normalizedUserId,
    usage: initialSnapshot?.usage
  }));
  const requestRef = useRef<AbortController | undefined>(undefined);
  const lastLoadedAtRef = useRef(initialSnapshot?.cachedAt ?? 0);

  const refresh = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setState((current) => ({
      error: false,
      loading: current.userId === normalizedUserId ? !current.usage : !initialSnapshot?.usage,
      userId: normalizedUserId,
      usage: current.userId === normalizedUserId ? current.usage : initialSnapshot?.usage
    }));

    try {
      const usage = await loadGroupUsage(controller.signal);
      if (!controller.signal.aborted) {
        lastLoadedAtRef.current = Date.now();
        writeCachedGroupUsage(normalizedUserId, usage);
        setState({ error: false, loading: false, userId: normalizedUserId, usage });
      }
    } catch {
      if (!controller.signal.aborted) {
        setState((current) => ({
          ...current,
          error: !current.usage,
          loading: false,
          userId: normalizedUserId
        }));
      }
    }
  }, [initialSnapshot?.usage, normalizedUserId]);

  useEffect(() => {
    lastLoadedAtRef.current = initialSnapshot?.cachedAt ?? 0;
    if (isGroupUsageCacheStale(initialSnapshot?.cachedAt)) {
      void refresh();
    }
    const timer = window.setInterval(() => void refresh(), GROUP_USAGE_REFRESH_MS);
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === "visible"
        && Date.now() - lastLoadedAtRef.current >= GROUP_USAGE_REFRESH_MS
      ) {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      requestRef.current?.abort();
    };
  }, [initialSnapshot?.cachedAt, refresh]);

  return groupUsageStateForUser(state, normalizedUserId, initialSnapshot?.usage);
}

export function groupUsageStateForUser(
  state: OwnedGroupUsageState,
  userId: string,
  cachedUsage?: GroupUsage
): GroupUsageState {
  if (state.userId === userId) {
    return state;
  }

  return {
    error: false,
    loading: !cachedUsage,
    usage: cachedUsage
  };
}

export async function loadGroupUsage(
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
  timeoutMs = GROUP_USAGE_REQUEST_TIMEOUT_MS
): Promise<GroupUsage> {
  const requestController = new AbortController();
  const abortFromCaller = () => requestController.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      requestController.abort(signal.reason);
    } else {
      signal.addEventListener("abort", abortFromCaller, { once: true });
    }
  }
  const timeoutId = setTimeout(() => requestController.abort(), timeoutMs);

  try {
    const response = await fetchImpl("/api/llm-gateway/group-usage", {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: requestController.signal
    });
    if (!response.ok) {
      throw new Error(`group_usage_request_failed:${response.status}`);
    }

    return groupUsageFromPayload(await response.json());
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function groupUsageFromPayload(value: unknown): GroupUsage {
  const row = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const startDate = String(row.startDate ?? "").trim();
  const updatedAt = String(row.updatedAt ?? "").trim();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(startDate)
    || Number.isNaN(Date.parse(`${startDate}T00:00:00Z`))
    || !updatedAt
    || Number.isNaN(Date.parse(updatedAt))
  ) {
    throw new Error("group_usage_invalid_payload");
  }

  return {
    requestCount: nonNegativeInteger(row.requestCount),
    startDate,
    totalTokens: nonNegativeInteger(row.totalTokens),
    updatedAt
  };
}

export function readCachedGroupUsage(
  userId: string,
  storage: StorageLike | undefined = browserSessionStorage()
): GroupUsage | undefined {
  return readCachedGroupUsageSnapshot(userId, storage)?.usage;
}

export function readCachedGroupUsageSnapshot(
  userId: string,
  storage: StorageLike | undefined = browserSessionStorage()
): GroupUsageSnapshot | undefined {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId || !storage) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(storage.getItem(GROUP_USAGE_SESSION_KEY) ?? "null") as Partial<CachedGroupUsage> | null;
    if (parsed?.userId !== normalizedUserId) {
      storage.removeItem(GROUP_USAGE_SESSION_KEY);
      return undefined;
    }
    if (typeof parsed.cachedAt !== "number" || !Number.isFinite(parsed.cachedAt)) {
      storage.removeItem(GROUP_USAGE_SESSION_KEY);
      return undefined;
    }
    return {
      cachedAt: parsed.cachedAt,
      usage: groupUsageFromPayload(parsed.usage)
    };
  } catch {
    try {
      storage.removeItem(GROUP_USAGE_SESSION_KEY);
    } catch {
      // Storage may be unavailable; the network request remains the source of truth.
    }
    return undefined;
  }
}

export function isGroupUsageCacheStale(cachedAt: number | undefined, now = Date.now()) {
  return !Number.isFinite(cachedAt)
    || cachedAt === undefined
    || cachedAt <= 0
    || cachedAt > now
    || now - cachedAt >= GROUP_USAGE_REFRESH_MS;
}

export function writeCachedGroupUsage(
  userId: string,
  usage: GroupUsage,
  storage: StorageLike | undefined = browserSessionStorage(),
  cachedAt = Date.now()
) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId || !storage) {
    return;
  }

  try {
    storage.setItem(GROUP_USAGE_SESSION_KEY, JSON.stringify({
      cachedAt,
      usage,
      userId: normalizedUserId
    } satisfies CachedGroupUsage));
  } catch {
    // The current in-memory value remains visible when browser storage is disabled or full.
  }
}

function browserSessionStorage(): StorageLike | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function nonNegativeInteger(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("group_usage_invalid_payload");
  }
  return Math.floor(parsed);
}
