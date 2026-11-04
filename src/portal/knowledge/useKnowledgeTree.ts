import type { KnowledgeMessageSetter } from "./types";
import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { KnowledgeItem, KnowledgeSection, KnowledgeTranslate } from "./types";
import {
  dedupeKnowledgeItems,
  isFolderBrowsingSection,
  knowledgeTreeCacheForUser,
  knowledgeTreeCacheFresh,
  knowledgeTreeCacheKey,
  loadTree,
  readRecentKnowledgeItems,
  recentKnowledgeStorageKey,
  writeKnowledgeTreeCache
} from "./tree";
import { errorMessage, normalizeApiItem } from "./utils";

// Own directory reads and user-scoped caches. Mutation workflows use the reconciliation helpers.
export function useKnowledgeTree({ userId, section, onSectionChange, setMessage, t }: {
  userId: string;
  section: KnowledgeSection;
  onSectionChange: (section: KnowledgeSection) => void;
  setMessage: KnowledgeMessageSetter;
  t: KnowledgeTranslate;
}) {
  const treeCache = knowledgeTreeCacheForUser(userId);
  const [cacheOwner, setCacheOwner] = useState(treeCache);
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [rootItems, setRootItems] = useState<KnowledgeItem[]>([]);
  const [recentItems, setRecentItems] = useState(() => readRecentKnowledgeItems(userId));
  const [path, setCurrentPath] = useState("");
  const [folderId, setCurrentFolderId] = useState("");
  const [folderTrail, setFolderTrail] = useState<KnowledgeItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const sameOwner = cacheOwner === treeCache;
  const currentPath = sameOwner ? path : "";
  const currentFolderId = sameOwner ? folderId : "";
  const cacheKey = knowledgeTreeCacheKey(section, currentPath, currentFolderId);
  const currentViewRef = useRef({ treeCache, cacheKey });
  const pendingFolderRef = useRef<KnowledgeItem | undefined>(undefined);
  const controllersRef = useRef(new Set<AbortController>());
  const readsRef = useRef(new WeakMap<Map<string, KnowledgeItem[]>, Map<string, symbol>>());
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    currentViewRef.current = { treeCache, cacheKey };
    if (!sameOwner) {
      setCacheOwner(treeCache);
      setItems([]);
      setRootItems([]);
      setRecentItems(readRecentKnowledgeItems(userId));
      setCurrentPath("");
      setCurrentFolderId("");
      setFolderTrail([]);
      setSelectedId("");
      pendingFolderRef.current = undefined;
    }
  }, [cacheKey, sameOwner, treeCache, userId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const controller of controllersRef.current) controller.abort();
      controllersRef.current.clear();
    };
  }, []);

  function isCurrentUser() {
    return mountedRef.current && currentViewRef.current.treeCache === treeCache;
  }

  function isCurrentView() {
    return isCurrentUser() && currentViewRef.current.cacheKey === cacheKey;
  }

  function startRead(key: string) {
    const reads = readsRef.current.get(treeCache) ?? new Map<string, symbol>();
    readsRef.current.set(treeCache, reads);
    const ticket = Symbol(key);
    reads.set(key, ticket);
    const controller = new AbortController();
    controllersRef.current.add(controller);
    return {
      controller,
      latest: () => !controller.signal.aborted && isCurrentUser() && reads.get(key) === ticket,
      release: () => controllersRef.current.delete(controller)
    };
  }

  useEffect(() => {
    const cachedItems = treeCache.get(cacheKey);
    if (cachedItems) {
      setItems(cachedItems);
      if (section === "my" && !currentFolderId) setRootItems(cachedItems);
      setIsLoading(false);
    } else {
      setIsLoading(true);
    }
    if (cachedItems && knowledgeTreeCacheFresh(treeCache, cacheKey)) return;

    const read = startRead(cacheKey);
    void loadTree(section, currentPath, currentFolderId, read.controller.signal)
      .then((response) => {
        if (!read.latest()) return;
        const nextItems = dedupeKnowledgeItems((response.items ?? []).map(normalizeApiItem));
        writeKnowledgeTreeCache(treeCache, cacheKey, nextItems);
        if (!isCurrentView()) return;
        setItems(nextItems);
        if (section === "my" && !currentFolderId) setRootItems(nextItems);
        setSelectedId((id) => id === currentFolderId || nextItems.some((item) => item.id === id) ? id : "");
        setMessage("");
      })
      .catch((error) => {
        if (!read.latest() || !isCurrentView()) return;
        if (!cachedItems) {
          setItems([]);
          setSelectedId("");
        }
        setMessage(errorMessage(error, t("knowledge.loadFailed")), "error");
      })
      .finally(() => {
        if (read.latest() && isCurrentView()) setIsLoading(false);
        read.release();
      });
    return () => { read.controller.abort(); read.release(); };
  }, [cacheKey, currentFolderId, currentPath, section, treeCache, t]);

  useEffect(() => {
    if (section !== "my" || !currentFolderId || rootItems.length) return;
    const rootKey = knowledgeTreeCacheKey("my", "", "");
    const read = startRead(rootKey);
    void loadTree("my", "", "", read.controller.signal)
      .then((response) => {
        if (!read.latest()) return;
        const nextItems = dedupeKnowledgeItems((response.items ?? []).map(normalizeApiItem));
        writeKnowledgeTreeCache(treeCache, rootKey, nextItems);
        setRootItems(nextItems);
      })
      .catch(() => {})
      .finally(read.release);
    return () => { read.controller.abort(); read.release(); };
  }, [currentFolderId, rootItems.length, section, treeCache]);

  useEffect(() => {
    const pendingFolder = section === "my" ? pendingFolderRef.current : undefined;
    pendingFolderRef.current = undefined;
    setCurrentPath(pendingFolder?.path ?? "");
    setCurrentFolderId(pendingFolder?.id ?? "");
    setFolderTrail(pendingFolder ? [pendingFolder] : []);
    setSelectedId(pendingFolder?.id ?? "");
  }, [section]);

  async function refreshCurrentFolder() {
    if (!isCurrentUser()) return false;
    const read = startRead(cacheKey);
    try {
      const response = await loadTree(section, currentPath, currentFolderId, read.controller.signal);
      if (!read.latest()) return false;
      const nextItems = dedupeKnowledgeItems((response.items ?? []).map(normalizeApiItem));
      writeKnowledgeTreeCache(treeCache, cacheKey, nextItems);
      if (!isCurrentView()) return false;
      setItems(nextItems);
      if (section === "my" && !currentFolderId) setRootItems(nextItems);
      return true;
    } catch (error) {
      if (!read.latest()) return false;
      throw error;
    } finally {
      if (read.latest() && isCurrentView()) setIsLoading(false);
      read.release();
    }
  }

  function browseFolder(item: KnowledgeItem) {
    if (section === "recent") {
      pendingFolderRef.current = item;
      onSectionChange("my");
      setSelectedId(item.id);
      return;
    }
    if (!isFolderBrowsingSection(section)) return;
    setItems([]);
    setIsLoading(true);
    setCurrentFolderId(item.id);
    setCurrentPath(item.path);
    setFolderTrail((current) => item.parentPath ? [...current, item] : [item]);
    setSelectedId(item.id);
  }

  function openBreadcrumb(id: string) {
    if (!isFolderBrowsingSection(section)) return;
    const index = folderTrail.findIndex((item) => item.id === id);
    if (index < 0) return;
    const nextTrail = folderTrail.slice(0, index + 1);
    const folder = nextTrail[nextTrail.length - 1];
    setItems([]);
    setIsLoading(true);
    setFolderTrail(nextTrail);
    setCurrentFolderId(folder.id);
    setCurrentPath(folder.path);
    setSelectedId(folder.id);
  }

  function browseRoot(nextSelectedId: string) {
    if (section === "my") {
      setItems(rootItems);
      setIsLoading(false);
    }
    setCurrentPath("");
    setCurrentFolderId("");
    setFolderTrail([]);
    setSelectedId(nextSelectedId);
  }

  function rememberRecentItem(item: KnowledgeItem) {
    if (item.kind === "folder") return;
    setRecentItems((current) => {
      const next = [item, ...current.filter((entry) => entry.id !== item.id)].slice(0, 20);
      try { window.localStorage.setItem(recentKnowledgeStorageKey(userId), JSON.stringify(next)); } catch { /* Browsing works without storage. */ }
      return next;
    });
  }

  function updateKnownKnowledgeItem(id: string, update: (item: KnowledgeItem) => KnowledgeItem) {
    if (!isCurrentUser()) return;
    const updateList = (current: KnowledgeItem[]) => current.map((item) => item.id === id ? update(item) : item);
    setItems(updateList);
    setRootItems(updateList);
    setFolderTrail(updateList);
    setRecentItems((current) => {
      const next = updateList(current);
      try { window.localStorage.setItem(recentKnowledgeStorageKey(userId), JSON.stringify(next)); } catch { /* Browsing works without storage. */ }
      return next;
    });
    treeCache.forEach((cachedItems, key) => {
      if (cachedItems.some((item) => item.id === id)) writeKnowledgeTreeCache(treeCache, key, updateList(cachedItems));
    });
  }

  return {
    items: sameOwner ? items : [], setItems, rootItems: sameOwner ? rootItems : [],
    recentItems: sameOwner ? recentItems : [], currentPath, setCurrentPath, currentFolderId, setCurrentFolderId,
    folderTrail: sameOwner ? folderTrail : [], setFolderTrail, selectedId: sameOwner ? selectedId : "", setSelectedId,
    isLoading, treeCache, browseFolder, openBreadcrumb, browseRoot, rememberRecentItem,
    refreshCurrentFolder, updateKnownKnowledgeItem, isCurrentView
  };
}
