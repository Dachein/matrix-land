import { useEffect, useMemo, useState } from "react";
import type { PortalCatalog } from "../../shared/types";
import { loadMemoryResource, readMemoryResource } from "../lib/memoryResourceCache";
import type { AccessTargetUser } from "../lib/accessTargets";
import { loadAccessTargetDirectory, type AccessTargetDirectory } from "../lib/accessTargetDirectory";

const DIRECTORY_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

export function useAccessTargetUsers(catalog: PortalCatalog, enabled = true) {
  const fallbackUser = useMemo<AccessTargetUser>(() => ({
    avatarUrl: catalog.currentUser.avatarUrl,
    id: catalog.currentUser.id,
    name: catalog.currentUser.name,
    email: catalog.currentUser.email,
    team: catalog.currentUser.team,
    department: catalog.currentUser.department,
    departmentId: catalog.currentUser.departmentId,
    departmentPath: catalog.currentUser.departmentPath
  }), [catalog.currentUser]);
  const cacheKey = `portal-directory:${catalog.currentUser.id}:access-v2`;
  const initialCache = readMemoryResource<AccessTargetDirectory>(cacheKey, DIRECTORY_CACHE_MAX_AGE_MS);
  const [directory, setDirectory] = useState<AccessTargetDirectory>(() => initialCache?.value ?? { users: [fallbackUser], departments: [] });
  const [loadedKey, setLoadedKey] = useState(cacheKey);
  const [state, setState] = useState<"loading" | "ready" | "error">(() => initialCache?.fresh ? "ready" : "loading");

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let cancelled = false;
    const cached = readMemoryResource<AccessTargetDirectory>(cacheKey, DIRECTORY_CACHE_MAX_AGE_MS);
    if (cached) {
      setDirectory(cached.value);
      setLoadedKey(cacheKey);
      if (cached.fresh) {
        setState("ready");
        return () => { cancelled = true; };
      }
    }

    async function loadUsers() {
      if (!cached) setDirectory({ users: [fallbackUser], departments: [] });
      setLoadedKey(cacheKey);
      setState("loading");

      try {
        const nextDirectory = await loadMemoryResource({
          key: cacheKey,
          maxAgeMs: DIRECTORY_CACHE_MAX_AGE_MS,
          load: () => loadAccessTargetDirectory()
        });

        if (!cancelled) {
          setDirectory(nextDirectory);
          setState("ready");
        }
      } catch {
        if (!cancelled) {
          setState("error");
        }
      }
    }

    void loadUsers();

    return () => { cancelled = true; };
  }, [cacheKey, enabled, fallbackUser]);

  return loadedKey === cacheKey ? { state, ...directory } : {
    state: "loading" as const, users: [fallbackUser], departments: []
  };
}
