import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GROUP_USAGE_SESSION_KEY,
  GROUP_USAGE_REFRESH_MS,
  groupUsageStateForUser,
  isGroupUsageCacheStale,
  loadGroupUsage,
  readCachedGroupUsage,
  readCachedGroupUsageSnapshot,
  writeCachedGroupUsage
} from "./useGroupUsage.ts";

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  removeItem(key) {
    this.values.delete(key);
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

const usage = {
  requestCount: 12_204,
  startDate: "2026-07-13",
  totalTokens: 48_200_122,
  updatedAt: "2026-08-17T04:00:00.000Z"
};

describe("group usage session snapshot", () => {
  it("restores the last successful value for the same user", () => {
    const storage = new MemoryStorage();
    writeCachedGroupUsage("user-1", usage, storage, 123);

    assert.deepEqual(readCachedGroupUsage("user-1", storage), usage);
    assert.deepEqual(readCachedGroupUsageSnapshot("user-1", storage), { cachedAt: 123, usage });
    assert.deepEqual(JSON.parse(storage.getItem(GROUP_USAGE_SESSION_KEY)), {
      cachedAt: 123,
      usage,
      userId: "user-1"
    });
  });

  it("reuses a cache for five minutes and refreshes at the stale boundary", () => {
    const now = 500_000;

    assert.equal(isGroupUsageCacheStale(now - GROUP_USAGE_REFRESH_MS + 1, now), false);
    assert.equal(isGroupUsageCacheStale(now - GROUP_USAGE_REFRESH_MS, now), true);
    assert.equal(isGroupUsageCacheStale(undefined, now), true);
    assert.equal(isGroupUsageCacheStale(now + 1, now), true);
  });

  it("does not expose a saved value to a different user", () => {
    const storage = new MemoryStorage();
    writeCachedGroupUsage("user-1", usage, storage);

    assert.equal(readCachedGroupUsage("user-2", storage), undefined);
    assert.equal(storage.getItem(GROUP_USAGE_SESSION_KEY), null);
  });

  it("does not expose the previous user's in-memory value after an account switch", () => {
    const previousUserState = {
      error: false,
      loading: false,
      userId: "user-1",
      usage
    };

    assert.deepEqual(groupUsageStateForUser(previousUserState, "user-2"), {
      error: false,
      loading: true,
      usage: undefined
    });
    assert.deepEqual(groupUsageStateForUser(previousUserState, "user-2", {
      ...usage,
      totalTokens: 20
    }), {
      error: false,
      loading: false,
      usage: { ...usage, totalTokens: 20 }
    });
  });

  it("discards malformed snapshots and lets the network request recover", () => {
    const storage = new MemoryStorage();
    storage.setItem(GROUP_USAGE_SESSION_KEY, JSON.stringify({
      cachedAt: 123,
      usage: { ...usage, updatedAt: "invalid" },
      userId: "user-1"
    }));

    assert.equal(readCachedGroupUsage("user-1", storage), undefined);
    assert.equal(storage.getItem(GROUP_USAGE_SESSION_KEY), null);
  });
});

describe("group usage request", () => {
  it("aborts a request that exceeds the timeout", async () => {
    let observedSignal;
    const pendingFetch = (_input, init) => {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    };

    await assert.rejects(loadGroupUsage(undefined, pendingFetch, 10), { name: "AbortError" });
    assert.equal(observedSignal.aborted, true);
  });
});
