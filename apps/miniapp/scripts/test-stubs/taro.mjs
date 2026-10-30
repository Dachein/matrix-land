/**
 * Minimal `@tarojs/taro` stand-in for the mini-program service tests.
 *
 * The published Taro runtime reads build-time globals (`ENABLE_INNER_HTML`, …) that only
 * exist in a webpack build, so it cannot be loaded by Node. The services under test never
 * reach the platform APIs on their own — every network and socket call is injected — this
 * stub only has to satisfy the module graph (`state.ts` storage, `socket.ts` connect).
 */
const storage = new Map();

export function getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; }
export function setStorageSync(key, value) { storage.set(key, value); }
export function removeStorageSync(key) { storage.delete(key); }

export function connectSocket() {
  throw new Error("connectSocket must be injected by ChatDependencies in tests");
}

export default { connectSocket, getStorageSync, removeStorageSync, setStorageSync };
