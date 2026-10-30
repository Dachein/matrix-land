import { useCallback, useEffect, useState } from "react";
import { loadMemoryResource, readMemoryResource } from "../../../../../src/portal/lib/memoryResourceCache";
import { loadModelHealth } from "./api";

const MODEL_HEALTH_CACHE_MAX_AGE_MS = 60 * 1000;
const MODEL_HEALTH_RUN_LIMIT = 28;

export function useModelHealth() {
  const cacheKey = `model-health:runs:${MODEL_HEALTH_RUN_LIMIT}`;
  const initialData = readMemoryResource<Awaited<ReturnType<typeof loadModelHealth>>>(
    cacheKey,
    MODEL_HEALTH_CACHE_MAX_AGE_MS
  )?.value;
  const [data, setData] = useState<Awaited<ReturnType<typeof loadModelHealth>> | undefined>(() => initialData);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(() => !initialData);
  const [query, setQuery] = useState("");

  const load = useCallback(async ({ forceRefresh = false }: { forceRefresh?: boolean } = {}) => {
    const cached = readMemoryResource<Awaited<ReturnType<typeof loadModelHealth>>>(
      cacheKey,
      MODEL_HEALTH_CACHE_MAX_AGE_MS
    );
    if (cached) {
      setData(cached.value);
    }
    setLoading(!cached);
    setError("");
    try {
      setData(await loadMemoryResource({
        forceRefresh,
        key: cacheKey,
        load: () => loadModelHealth(MODEL_HEALTH_RUN_LIMIT),
        maxAgeMs: MODEL_HEALTH_CACHE_MAX_AGE_MS
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "model_health_load_failed");
    } finally {
      setLoading(false);
    }
  }, [cacheKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const normalizedQuery = query.trim().toLowerCase();
  const models = (data?.models ?? []).filter((model) => !normalizedQuery || [
    model.id,
    model.displayName,
    model.vendorId
  ].some((value) => value.toLowerCase().includes(normalizedQuery)));

  return {
    data,
    error,
    load,
    loading,
    models,
    query,
    setQuery
  };
}
