import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearAllMateDirectoryCaches,
  clearMateDirectoryCache,
  readMateDirectoryCache,
  mateDirectoryCacheKey,
  writeMateDirectoryCache
} from "./directoryCache.ts";

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}

const session = {
  principalKey: "opaque-user-a",
  mate: { id: "mate-a" },
  mode: "live",
  release: { id: "release-a" },
  accessToken: "secret-bearer"
};
const item = { id: "conv-a", pinned: false, status: "active", title: "Recent discussion", updatedAt: "2026-09-28T00:00:00Z" };

describe("Mate browser directory cache", () => {
  it("stores directory metadata without session credentials and isolates users and Mates", () => {
    const local = storage();
    writeMateDirectoryCache(local, session, "conversations", [item], 1_000);
    assert.deepEqual(readMateDirectoryCache(local, session, "conversations"), [item]);
    assert.equal(local.getItem(mateDirectoryCacheKey(session, "conversations")).includes("secret-bearer"), false);
    assert.equal(readMateDirectoryCache(local, { ...session, principalKey: "opaque-user-b" }, "conversations"), undefined);
    assert.equal(readMateDirectoryCache(local, { ...session, mate: { id: "mate-b" } }, "conversations"), undefined);
    assert.equal(readMateDirectoryCache(local, session, "tasks"), undefined);
  });

  it("retains history without a time limit and removes malformed data", () => {
    const local = storage();
    const key = mateDirectoryCacheKey(session, "conversations");
    writeMateDirectoryCache(local, session, "conversations", [item], 1_000);
    assert.deepEqual(readMateDirectoryCache(local, session, "conversations"), [item]);
    local.setItem(key, JSON.stringify({ items: [{ ...item, title: 42 }], updatedAt: 301_001 }));
    assert.equal(readMateDirectoryCache(local, session, "conversations"), undefined);
    assert.equal(local.getItem(key), null);
  });

  it("invalidates cached history after a server-side change", () => {
    const local = storage();
    writeMateDirectoryCache(local, session, "conversations", [item], 1_000);
    clearMateDirectoryCache(local, session, "conversations");
    assert.equal(readMateDirectoryCache(local, session, "conversations"), undefined);
  });

  it("removes Mate metadata on logout without clearing unrelated preferences", () => {
    const local = storage();
    local.setItem("workspace-ai:locale", "zh-CN");
    writeMateDirectoryCache(local, session, "conversations", [item], 1_000);
    clearAllMateDirectoryCaches(local);
    assert.equal(readMateDirectoryCache(local, session, "conversations"), undefined);
    assert.equal(local.getItem("workspace-ai:locale"), "zh-CN");
  });
});
