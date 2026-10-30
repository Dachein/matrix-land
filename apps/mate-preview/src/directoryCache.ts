import type { MatePreviewSession, MateRuntimeDirectoryItem } from "./api";

const PREFIX = "workspace.mate.directory.v1:";
type Resource = "conversations" | "tasks";
type DirectoryCacheEntry = { items: MateRuntimeDirectoryItem[]; updatedAt: number };

export function mateDirectoryCacheKey(session: MatePreviewSession, resource: Resource) {
  return PREFIX + [
    session.principalKey,
    session.mate.id,
    session.mode,
    session.mode === "preview" ? session.release.id : "live",
    resource
  ].map(encodeURIComponent).join(":");
}

export function readMateDirectoryCache(
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined,
  session: MatePreviewSession,
  resource: Resource
): MateRuntimeDirectoryItem[] | undefined {
  if (!storage) return undefined;
  const key = mateDirectoryCacheKey(session, resource);
  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as DirectoryCacheEntry;
    if (!validEntry(entry)) {
      storage.removeItem(key);
      return undefined;
    }
    return entry.items;
  } catch {
    return undefined;
  }
}

export function writeMateDirectoryCache(
  storage: Storage | undefined,
  session: MatePreviewSession,
  resource: Resource,
  items: MateRuntimeDirectoryItem[],
  now = Date.now()
) {
  if (!storage) return;
  try {
    storage.setItem(mateDirectoryCacheKey(session, resource), JSON.stringify({
      items, updatedAt: now
    } satisfies DirectoryCacheEntry));
  } catch {
    // Browser storage is an optional display cache.
  }
}

export function clearMateDirectoryCache(
  storage: Pick<Storage, "removeItem"> | undefined,
  session: MatePreviewSession,
  resource?: Resource
) {
  if (!storage) return;
  try {
    for (const selected of resource ? [resource] : ["conversations", "tasks"] as const) {
      storage.removeItem(mateDirectoryCacheKey(session, selected));
    }
  } catch {
    // A storage policy must not block server-side changes.
  }
}

export function clearAllMateDirectoryCaches(storage: Storage | undefined) {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Logout continues even if the browser blocks localStorage.
  }
}

export function browserDirectoryStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function validEntry(value: unknown): value is DirectoryCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<DirectoryCacheEntry>;
  return Number.isSafeInteger(entry.updatedAt) && Array.isArray(entry.items)
    && entry.items.every(validItem);
}

function validItem(value: unknown): value is MateRuntimeDirectoryItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<MateRuntimeDirectoryItem>;
  return typeof item.id === "string" && item.id.length <= 180
    && typeof item.title === "string" && item.title.length <= 500
    && typeof item.pinned === "boolean"
    && (item.status === undefined || typeof item.status === "string" && item.status.length <= 80)
    && (item.updatedAt === undefined || typeof item.updatedAt === "string" && item.updatedAt.length <= 100);
}
