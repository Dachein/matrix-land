import { useCallback, useEffect, useState } from "react";
import { loadAdminKnowledgeServices } from "./api";
import type { AdminKnowledgeServiceData } from "./types";

const emptyData: AdminKnowledgeServiceData = {
  services: [],
  summary: {
    companyVisibleCount: 0,
    fileCount: 0,
    requestCount: 0,
    serviceCount: 0
  }
};

export function usePortalAdminKnowledgeServices(currentUserId: string) {
  const [data, setData] = useState<AdminKnowledgeServiceData>(emptyData);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      setData(await loadAdminKnowledgeServices(signal));
    } catch (caught) {
      if (signal?.aborted) {
        return;
      }
      setData(emptyData);
      setError(caught instanceof Error ? caught.message : "admin_knowledge_services_unavailable");
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [currentUserId, load]);

  return { data, error, load, loading };
}
