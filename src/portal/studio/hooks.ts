import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AppsApp, AppsSkill, PortalCatalog } from "../../shared/types";
import type { Mate } from "../../shared/mate";
import {
  defaultMcpConnectionStatus,
  type McpConnectionStatus,
  type McpConnectionStatusMode
} from "../components/McpConnectionModal";
import { loadMemoryResource, readMemoryResource, writeMemoryResource } from "../lib/memoryResourceCache";
import {
  configureMcpConnectionStatusCache,
  getCachedMcpConnectionStatus,
  readCachedMcpConnectionStatus
} from "../mcp/connectionStatusCache";
import { appsApiBase, appsApiFetch } from "./apiClient";
import { isCurrentAppsAssetAuthor } from "./productModels";
import type { ApiAppsInventoryPayload } from "./types";

const APPS_INVENTORY_CACHE_MAX_AGE_MS = 30 * 1000;

function appsInventoryRequestKey(catalog: PortalCatalog) {
  return `apps-inventory:${appsApiBase()}:${catalog.currentUser.id}:${catalog.currentUser.email}`;
}

function loadAppsInventory(catalog: PortalCatalog) {
  const key = appsInventoryRequestKey(catalog);
  const startedAt = globalThis.performance?.now?.();
  return loadMemoryResource({
    key,
    maxAgeMs: APPS_INVENTORY_CACHE_MAX_AGE_MS,
    load: () => appsApiFetch<ApiAppsInventoryPayload>("/inventory", catalog)
  }).finally(() => {
    if (startedAt === undefined || !globalThis.performance?.measure) return;
    try {
      globalThis.performance.measure("portal:apps-inventory", {
        start: startedAt,
        duration: globalThis.performance.now() - startedAt
      });
    } catch {
      // Diagnostics cannot block the inventory.
    }
  });
}

export function useAppsInventory(catalog: PortalCatalog) {
  const [ownershipRevision, setOwnershipRevision] = useState(0);
  useEffect(() => {
    const update = () => setOwnershipRevision(v => v + 1);
    window.addEventListener('workspace:apps-ownership-changed', update);
    return () => window.removeEventListener('workspace:apps-ownership-changed', update);
  }, []);
  const cacheKey = appsInventoryRequestKey(catalog);
  const initialCache = readMemoryResource<ApiAppsInventoryPayload>(cacheKey, APPS_INVENTORY_CACHE_MAX_AGE_MS);
  const [apps, setAppsState] = useState<AppsApp[]>(() => initialCache?.value.apps ?? []);
  const [skills, setSkillsState] = useState<AppsSkill[]>(() => initialCache?.value.skills ?? []);
  const [mates, setMatesState] = useState<Mate[]>(() => initialCache?.value.mates ?? []);
  const [apiMode, setApiMode] = useState<"live" | "offline" | "loading">(() => initialCache ? "live" : "loading");
  const appsRef = useRef(apps);
  const skillsRef = useRef(skills);
  const matesRef = useRef(mates);

  const setApps = useCallback<Dispatch<SetStateAction<AppsApp[]>>>((update) => {
    setAppsState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      appsRef.current = next;
      writeMemoryResource(cacheKey, { apps: next, skills: skillsRef.current, mates: matesRef.current });
      return next;
    });
  }, [cacheKey]);

  const setSkills = useCallback<Dispatch<SetStateAction<AppsSkill[]>>>((update) => {
    setSkillsState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      skillsRef.current = next;
      writeMemoryResource(cacheKey, { apps: appsRef.current, skills: next, mates: matesRef.current });
      return next;
    });
  }, [cacheKey]);

  const setMates = useCallback<Dispatch<SetStateAction<Mate[]>>>((update) => {
    setMatesState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      matesRef.current = next;
      writeMemoryResource(cacheKey, { apps: appsRef.current, skills: skillsRef.current, mates: next });
      return next;
    });
  }, [cacheKey]);

  useEffect(() => {
    let cancelled = false;

    void (ownershipRevision ? appsApiFetch<ApiAppsInventoryPayload>("/inventory", catalog) : loadAppsInventory(catalog))
      .then((payload) => {
        if (cancelled) {
          return;
        }

        setApps(payload.apps);
        setSkills(payload.skills);
        setMates(payload.mates ?? []);
        setApiMode("live");
      })
      .catch(() => {
        if (!cancelled) {
          // Keep the last user-scoped inventory visible when a refresh fails.
          setApiMode("offline");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [catalog, ownershipRevision, setApps, setSkills, setMates]);

  function replaceApp(app: AppsApp) {
    setApps((current) => {
      if (!isCurrentAppsAssetAuthor(app, catalog.currentUser)) {
        return current.filter((item) => item.id !== app.id);
      }

      return current.some((item) => item.id === app.id)
        ? current.map((item) => item.id === app.id ? app : item)
        : [app, ...current];
    });
  }

  function replaceSkill(skill: AppsSkill) {
    setSkills((current) => {
      if (!isCurrentAppsAssetAuthor(skill, catalog.currentUser)) {
        return current.filter((item) => item.id !== skill.id);
      }

      return current.some((item) => item.id === skill.id)
        ? current.map((item) => item.id === skill.id ? skill : item)
        : [skill, ...current];
    });
  }

  function replaceMate(mate: Mate) {
    setMates((current) => current.some((item) => item.id === mate.id)
      ? current.map((item) => item.id === mate.id ? mate : item)
      : [mate, ...current]);
  }

  return { apiMode, apps, replaceApp, replaceSkill, replaceMate, setApiMode, setApps, setSkills, setMates, skills, mates };
}

export function useAppsMcpStatus(userId: string) {
  const [mcpConnectionStatus, setMcpConnectionStatus] = useState<McpConnectionStatus>(defaultMcpConnectionStatus);
  const [mcpStatusMode, setMcpStatusMode] = useState<McpConnectionStatusMode>("loading");

  useEffect(() => {
    let cancelled = false;

    configureMcpConnectionStatusCache(userId);
    const cached = readCachedMcpConnectionStatus();
    if (cached) {
      setMcpConnectionStatus(cached.status);
      setMcpStatusMode("ready");
    } else {
      setMcpStatusMode("loading");
    }
    getCachedMcpConnectionStatus()
      .then((status) => {
        if (!cancelled) {
          setMcpConnectionStatus(status);
          setMcpStatusMode("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMcpStatusMode("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function refreshMcpConnectionStatus() {
    setMcpStatusMode("loading");
    try {
      setMcpConnectionStatus(await getCachedMcpConnectionStatus({ forceRefresh: true }));
      setMcpStatusMode("ready");
    } catch {
      setMcpStatusMode("error");
    }
  }

  return { mcpConnectionStatus, mcpStatusMode, refreshMcpConnectionStatus };
}
