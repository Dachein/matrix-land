import Taro from "@tarojs/taro";
import { isProcessPart, isVisibleChatPart } from "./chatPresentation";
import type { ChatMessage } from "../types";

const STORAGE_KEY = "workspace.mini.messages/v1";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 6;
const MESSAGE_LIMIT = 60;
const ENTRY_CHAR_LIMIT = 80_000;
const TOTAL_CHAR_LIMIT = 240_000;

type Entry = { savedAt: number; messages: ChatMessage[] };
type Entries = Record<string, Entry>;
type StorageAdapter = { read: () => unknown; write: (entries: Entries) => void; clear: () => void };

/** Local, size-bounded persistence with a memory fallback if the platform quota is reached. */
export function createMessageCache(storage: StorageAdapter) {
  const memory = new Map<string, Entry>();

  function readEntries(): Entries {
    try {
      const value = storage.read();
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return value as Entries;
    } catch { return {}; }
  }

  function get(ownerId: string, mateId: string, conversationId: string, now = Date.now()) {
    if (!ownerId || !mateId || !conversationId) return undefined;
    const key = cacheKey(ownerId, mateId, conversationId);
    const entry = memory.get(key) || readEntries()[key];
    if (!entry || !Number.isFinite(entry.savedAt) || !Array.isArray(entry.messages) || now - entry.savedAt > CACHE_TTL_MS) {
      memory.delete(key);
      if (entry) removeStored(key);
      return undefined;
    }
    memory.delete(key);
    memory.set(key, entry);
    while (memory.size > CACHE_LIMIT) memory.delete(memory.keys().next().value as string);
    return clone(entry.messages);
  }

  function set(ownerId: string, mateId: string, conversationId: string, messages: ChatMessage[], now = Date.now()) {
    if (!ownerId || !mateId || !conversationId || !messages.length) return;
    const recent = messages.slice(-MESSAGE_LIMIT).map((message) => ({
      ...message,
      parts: message.parts
        .filter((part) => isVisibleChatPart(part) && !isProcessPart(part))
        .filter((part) => part.type !== "reasoning" && part.type !== "reasoning-file")
        .filter((part) => part.state !== "approval-requested" && part.state !== "input-streaming" && part.state !== "input-available")
        .map((part) => {
          const { input: _input, output: _output, approval: _approval, ...visiblePart } = part;
          return visiblePart;
        })
    }));
    const encodedSize = JSON.stringify(recent).length;
    if (encodedSize > ENTRY_CHAR_LIMIT) return;

    const key = cacheKey(ownerId, mateId, conversationId);
    const entry = { savedAt: now, messages: recent };
    memory.delete(key);
    memory.set(key, entry);
    while (memory.size > CACHE_LIMIT) memory.delete(memory.keys().next().value as string);

    const entries = readEntries();
    for (const [storedKey, stored] of Object.entries(entries)) {
      if (!stored || !Number.isFinite(stored.savedAt) || now - stored.savedAt > CACHE_TTL_MS || !Array.isArray(stored.messages)) delete entries[storedKey];
    }
    entries[key] = entry;
    const oldestFirst = () => Object.entries(entries).sort((left, right) => left[1].savedAt - right[1].savedAt);
    while (Object.keys(entries).length > CACHE_LIMIT || JSON.stringify(entries).length > TOTAL_CHAR_LIMIT) {
      const oldest = oldestFirst()[0]?.[0];
      if (!oldest) break;
      delete entries[oldest];
    }
    if (!entries[key]) return;
    try { storage.write(entries); } catch { /* Continue with the in-memory copy when storage is full/unavailable. */ }
  }

  function clear() {
    memory.clear();
    try { storage.clear(); } catch { /* The page session is still cleared from memory. */ }
  }

  function removeStored(key: string) {
    const entries = readEntries();
    if (!(key in entries)) return;
    delete entries[key];
    try { storage.write(entries); } catch { /* Expired content is already ignored on read. */ }
  }

  return { get, set, clear };
}

const persistentCache = createMessageCache({
  read: () => Taro.getStorageSync(STORAGE_KEY),
  write: (entries) => Taro.setStorageSync(STORAGE_KEY, entries),
  clear: () => Taro.removeStorageSync(STORAGE_KEY)
});

export const getCachedMessages = persistentCache.get;
export const setCachedMessages = persistentCache.set;
export const clearMessageCache = persistentCache.clear;

function cacheKey(ownerId: string, mateId: string, conversationId: string) { return JSON.stringify([ownerId, mateId, conversationId]); }

function clone(messages: ChatMessage[]) {
  return messages.map((message) => ({ ...message, parts: message.parts.map((part) => ({ ...part })) }));
}
