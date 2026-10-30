type MemoryResourceEntry<T> = {
  cachedAt: number;
  value: T;
};

export type MemoryResourceSnapshot<T> = MemoryResourceEntry<T> & {
  fresh: boolean;
};

const entries = new Map<string, MemoryResourceEntry<unknown>>();
const pending = new Map<string, Promise<unknown>>();

/**
 * Session-scoped cache for authenticated read models.
 *
 * Values never leave the current JavaScript realm. Callers must include the
 * user/org boundary in the key and explicitly invalidate after mutations.
 */
export function readMemoryResource<T>(
  key: string,
  maxAgeMs: number,
  now = Date.now()
): MemoryResourceSnapshot<T> | undefined {
  const entry = entries.get(key) as MemoryResourceEntry<T> | undefined;
  if (!entry) {
    return undefined;
  }

  return {
    ...entry,
    fresh: now - entry.cachedAt < Math.max(0, maxAgeMs)
  };
}

export function writeMemoryResource<T>(key: string, value: T, cachedAt = Date.now()) {
  entries.set(key, { cachedAt, value });
  return value;
}

export async function loadMemoryResource<T>({
  forceRefresh = false,
  key,
  load,
  maxAgeMs,
  now = Date.now()
}: {
  forceRefresh?: boolean;
  key: string;
  load: () => Promise<T>;
  maxAgeMs: number;
  now?: number;
}) {
  const cached = readMemoryResource<T>(key, maxAgeMs, now);
  if (!forceRefresh && cached?.fresh) {
    return cached.value;
  }

  const active = pending.get(key) as Promise<T> | undefined;
  if (active) {
    return await active;
  }

  const request = load()
    .then((value) => {
      // A mutation may invalidate this key while the read is still in flight.
      // Never let that obsolete response repopulate the cache afterwards.
      if (pending.get(key) === request) {
        writeMemoryResource(key, value);
      }
      return value;
    })
    .finally(() => {
      if (pending.get(key) === request) {
        pending.delete(key);
      }
    });
  pending.set(key, request);
  return await request;
}

export function invalidateMemoryResource(key: string) {
  entries.delete(key);
  pending.delete(key);
}

export function invalidateMemoryResources(prefix: string) {
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) {
      entries.delete(key);
    }
  }
  for (const key of pending.keys()) {
    if (key.startsWith(prefix)) {
      pending.delete(key);
    }
  }
}

export function clearMemoryResources() {
  entries.clear();
  pending.clear();
}
