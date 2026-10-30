import Taro from "@tarojs/taro";
import { clearMessageCache } from "./services/messageCache";
import type { ChatCapabilitySelection, LiveSession, Mate, UploadedAttachment, User } from "./types";

const KEYS = {
  cookie: "workspace.mini.cookie/v1",
  user: "workspace.mini.user/v1",
  mates: "workspace.mini.mates/v1",
  matesCached: "workspace.mini.mates-cached/v1",
  matesRefreshPending: "workspace.mini.mates-refresh-pending/v1",
  mate: "workspace.mini.mate/v1",
  liveSession: "workspace.mini.live-session/v1",
  pendingImport: "workspace.mini.pending-import/v1"
};

export const state = {
  getCookie: () => Taro.getStorageSync<string>(KEYS.cookie) || "",
  setCookie: (value: string) => Taro.setStorageSync(KEYS.cookie, value),
  getUser: () => Taro.getStorageSync<User | undefined>(KEYS.user),
  setUser: (value: User) => Taro.setStorageSync(KEYS.user, value),
  clearUser: () => Taro.removeStorageSync(KEYS.user),
  getMates: () => {
    const value = Taro.getStorageSync<Mate[] | undefined>(KEYS.mates);
    return Array.isArray(value) ? value : [];
  },
  hasMatesCache: () => Boolean(Taro.getStorageSync(KEYS.matesCached)),
  setMates: (value: Mate[]) => { Taro.setStorageSync(KEYS.mates, value); Taro.setStorageSync(KEYS.matesCached, true); },
  requestMatesRefresh: () => Taro.setStorageSync(KEYS.matesRefreshPending, true),
  consumeMatesRefresh: () => {
    const pending = Boolean(Taro.getStorageSync(KEYS.matesRefreshPending));
    if (pending) Taro.removeStorageSync(KEYS.matesRefreshPending);
    return pending;
  },
  getMate: () => Taro.getStorageSync<Mate | undefined>(KEYS.mate),
  setMate: (value: Mate) => Taro.setStorageSync(KEYS.mate, value),
  getLiveSession: (): LiveSession | undefined => {
    const value = Taro.getStorageSync<LiveSession | undefined>(KEYS.liveSession);
    if (!value || typeof value !== "object" || !value.mate?.id) return undefined;
    return value;
  },
  setLiveSession: (value: LiveSession) => Taro.setStorageSync(KEYS.liveSession, value),
  clearLiveSession: () => Taro.removeStorageSync(KEYS.liveSession),
  setPendingImport: (mateId: string, attachment: UploadedAttachment) => Taro.setStorageSync(KEYS.pendingImport, { mateId, attachment }),
  consumePendingImport: (mateId: string): UploadedAttachment | undefined => {
    const pending = Taro.getStorageSync<{ mateId: string; attachment: UploadedAttachment } | undefined>(KEYS.pendingImport);
    if (!pending || pending.mateId !== mateId) return undefined;
    Taro.removeStorageSync(KEYS.pendingImport);
    return pending.attachment;
  },
  getCapabilitySelection: (mateId: string) => normalizeCapabilitySelection(Taro.getStorageSync<unknown>(`workspace.mini.capabilities/v1/${mateId}`)),
  setCapabilitySelection: (mateId: string, value: ChatCapabilitySelection) => Taro.setStorageSync(`workspace.mini.capabilities/v1/${mateId}`, value),
  clearAuth: () => {
    clearMessageCache();
    Taro.removeStorageSync(KEYS.cookie);
    Taro.removeStorageSync(KEYS.user);
    Taro.removeStorageSync(KEYS.mates);
    Taro.removeStorageSync(KEYS.matesCached);
    Taro.removeStorageSync(KEYS.matesRefreshPending);
    Taro.removeStorageSync(KEYS.mate);
    Taro.removeStorageSync(KEYS.liveSession);
    Taro.removeStorageSync(KEYS.pendingImport);
  }
};

function normalizeCapabilitySelection(value: unknown): ChatCapabilitySelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const saved = value as Partial<ChatCapabilitySelection>;
  return {
    appIds: Array.isArray(saved.appIds) ? saved.appIds.filter((id): id is string => typeof id === "string") : [],
    knowledgeServiceIds: Array.isArray(saved.knowledgeServiceIds)
      ? saved.knowledgeServiceIds.filter((id): id is string => typeof id === "string")
      : [],
    ...(typeof saved.modelId === "string" ? { modelId: saved.modelId } : {})
  };
}
