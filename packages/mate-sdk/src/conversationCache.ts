export type WorkspaceMateConversationCacheCoordinate = {
  conversationId: string;
  mode: "live" | "preview";
  principalKey: string;
  releaseId?: string;
  mateId: string;
};

type WorkspaceMateConversationCacheScope = Omit<WorkspaceMateConversationCacheCoordinate, "conversationId">;

export type WorkspaceMateConversationCacheOptions = {
  maxConversations?: number;
  maxMessages?: number;
  now?: () => number;
  ttlMs?: number;
};

const PERSISTENT_PREFIX = "workspace.mate.transcript.v1:";

/** Browser-local transcript copies have no time expiry. The server remains authoritative. */
export class WorkspaceMatePersistentConversationCache {
  readonly #storage: () => Storage | undefined;

  constructor(storage: () => Storage | undefined = browserLocalStorage) {
    this.#storage = storage;
  }

  read<Message>(coordinate: WorkspaceMateConversationCacheCoordinate): Message[] | undefined {
    try {
      const storage = this.#storage();
      const raw = storage?.getItem(persistentConversationKey(coordinate));
      if (!raw) return undefined;
      const value = JSON.parse(raw) as { messages?: unknown };
      if (!Array.isArray(value.messages) || !value.messages.every(validStoredMessage)) return undefined;
      return cloneMessages(value.messages) as Message[];
    } catch {
      return undefined;
    }
  }

  write<Message>(coordinate: WorkspaceMateConversationCacheCoordinate, messages: readonly Message[]) {
    try {
      this.#storage()?.setItem(persistentConversationKey(coordinate), JSON.stringify({ messages }));
    } catch {
      // A browser quota or storage policy must not interrupt the conversation.
    }
  }

  clear(coordinate?: WorkspaceMateConversationCacheCoordinate) {
    try {
      const storage = this.#storage();
      if (!storage) return;
      if (coordinate) {
        storage.removeItem(persistentConversationKey(coordinate));
        return;
      }
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(PERSISTENT_PREFIX)) keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    } catch {
      // Clearing a local copy must not block server-side deletion or logout.
    }
  }

  clearScope(scope: WorkspaceMateConversationCacheScope) {
    try {
      const storage = this.#storage();
      if (!storage) return;
      const keys: string[] = [];
      const prefix = persistentConversationScopePrefix(scope);
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    } catch {
      // Clearing a local copy must not block server-side deletion.
    }
  }
}

export function clearAllWorkspaceMatePersistentConversationCaches() {
  new WorkspaceMatePersistentConversationCache().clear();
}

function persistentConversationKey(coordinate: WorkspaceMateConversationCacheCoordinate) {
  return persistentConversationScopePrefix(coordinate) + encodeURIComponent(coordinate.conversationId);
}

function persistentConversationScopePrefix(scope: WorkspaceMateConversationCacheScope) {
  return PERSISTENT_PREFIX + [
    scope.principalKey,
    scope.mateId,
    scope.mode,
    scope.mode === "preview" ? scope.releaseId ?? "" : "live"
  ].map(encodeURIComponent).join(":") + ":";
}

function validStoredMessage(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const message = value as { id?: unknown; role?: unknown; parts?: unknown };
  return typeof message.id === "string" && ["user", "assistant", "system"].includes(String(message.role))
    && Array.isArray(message.parts);
}

function browserLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

type CacheEntry = { messages: unknown[]; updatedAt: number };

/**
 * A bounded tab-memory transcript cache. Browser persistence is handled
 * separately so server grants and runtime sessions never enter Web Storage.
 */
export class WorkspaceMateConversationCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #maxConversations: number;
  readonly #maxMessages: number;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: WorkspaceMateConversationCacheOptions = {}) {
    this.#maxConversations = boundedInteger(options.maxConversations, 24, 1, 100);
    this.#maxMessages = boundedInteger(options.maxMessages, 80, 1, 500);
    this.#now = options.now ?? Date.now;
    this.#ttlMs = boundedInteger(options.ttlMs, 15 * 60_000, 1_000, 24 * 60 * 60_000);
  }

  clear(coordinate?: WorkspaceMateConversationCacheCoordinate) {
    if (!coordinate) {
      this.#entries.clear();
      return;
    }
    this.#entries.delete(workspaceMateConversationCacheKey(coordinate));
  }

  clearScope(scope: WorkspaceMateConversationCacheScope) {
    const prefix = workspaceMateConversationCacheScopePrefix(scope);
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
  }

  read<Message>(coordinate: WorkspaceMateConversationCacheCoordinate): Message[] | undefined {
    const key = workspaceMateConversationCacheKey(coordinate);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (this.#now() - entry.updatedAt > this.#ttlMs) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return cloneMessages(entry.messages) as Message[];
  }

  write<Message>(coordinate: WorkspaceMateConversationCacheCoordinate, messages: readonly Message[]) {
    const key = workspaceMateConversationCacheKey(coordinate);
    const bounded = messages.slice(-this.#maxMessages);
    this.#entries.delete(key);
    this.#entries.set(key, { messages: cloneMessages(bounded), updatedAt: this.#now() });
    while (this.#entries.size > this.#maxConversations) {
      const oldest = this.#entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#entries.delete(oldest);
    }
  }
}

export function workspaceMateConversationCacheKey(coordinate: WorkspaceMateConversationCacheCoordinate) {
  return workspaceMateConversationCacheScopePrefix(coordinate) + coordinate.conversationId;
}

function workspaceMateConversationCacheScopePrefix(scope: WorkspaceMateConversationCacheScope) {
  return [
    "workspace-mate-transcript-v1",
    scope.principalKey,
    scope.mateId,
    scope.mode,
    scope.mode === "preview" ? scope.releaseId ?? "" : "live",
    ""
  ].join("\u0000");
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function cloneMessages<Message>(messages: readonly Message[]): Message[] {
  try {
    return structuredClone(messages) as Message[];
  } catch {
    return [...messages];
  }
}
