import { useEffect, useMemo, useState } from "react";
import type { PortalCatalog } from "../../shared/types";
import type { PeopleMentionCandidate } from "../components/PeopleMentionPicker";
import { loadMemoryResource, readMemoryResource } from "../lib/memoryResourceCache";

type DirectoryPerson = PeopleMentionCandidate & { email: string };
const DIRECTORY_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Loads active and invited Auth-directory users for people-only pickers such
 * as Knowledge and APPS collaborators. Forum @mentions use the same status
 * policy through the query-oriented `purpose=mention` endpoint.
 */
export function usePeopleDirectory(catalog: PortalCatalog, enabled = true, activeOnly = false) {
  const fallbackPerson = useMemo<DirectoryPerson>(() => ({
    avatarUrl: catalog.currentUser.avatarUrl,
    email: catalog.currentUser.email,
    id: catalog.currentUser.id,
    name: catalog.currentUser.name || catalog.currentUser.email
  }), [catalog.currentUser]);
  const cacheKey = `portal-directory:${catalog.currentUser.id}:people${activeOnly ? ':active' : ''}`;
  const initialCache = readMemoryResource<DirectoryPerson[]>(cacheKey, DIRECTORY_CACHE_MAX_AGE_MS);
  const [people, setPeople] = useState<DirectoryPerson[]>(() => initialCache?.value ?? [fallbackPerson]);
  const [state, setState] = useState<"loading" | "ready" | "error">(() => initialCache ? "ready" : "loading");

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let cancelled = false;
    const cached = readMemoryResource<DirectoryPerson[]>(cacheKey, DIRECTORY_CACHE_MAX_AGE_MS);
    if (cached) {
      setPeople(cached.value);
      setState("ready");
      if (cached.fresh) {
        return () => { cancelled = true; };
      }
    }

    async function loadPeople() {
      if (!cached) {
        setState("loading");
      }

      try {
        const nextPeople = await loadMemoryResource({
          key: cacheKey,
          maxAgeMs: DIRECTORY_CACHE_MAX_AGE_MS,
          load: async () => {
            const response = await fetch(
              `/api/users/directory?purpose=directory&status=active${activeOnly ? "" : "&status=invited"}&limit=1000`
            );
            if (!response.ok) {
              throw new Error("people_directory_unavailable");
            }
            const payload = await response.json() as { users?: Array<Record<string, unknown>> };
            const loadedPeople = (payload.users ?? []).flatMap(readDirectoryPerson);
            return loadedPeople.length > 0 ? loadedPeople : [fallbackPerson];
          }
        });

        if (!cancelled) {
          setPeople(nextPeople);
          setState("ready");
        }
      } catch {
        if (!cancelled && !cached) {
          setPeople([fallbackPerson]);
          setState("error");
        }
      }
    }

    void loadPeople();
    return () => { cancelled = true; };
  }, [activeOnly, cacheKey, enabled, fallbackPerson]);

  return { people, state };
}

function readDirectoryPerson(value: Record<string, unknown>): DirectoryPerson[] {
  const id = readString(value.id);
  const email = readString(value.email);

  if (!id || !email) {
    return [];
  }

  return [{
    avatarUrl: readString(value.avatarUrl) || undefined,
    email,
    id,
    name: readString(value.name) || email
  }];
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
