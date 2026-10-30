import { useCallback, useEffect, useState } from "react";
import { disableAdminMcpConnection, loadAdminMcpConnections } from "./api";
import type {
  AdminMcpConnectionData,
  AdminMcpConnectionStatusFilter
} from "./types";

const emptyData: AdminMcpConnectionData = {
  connections: [],
  summary: { activeCount: 0, inactiveCount: 0, totalCount: 0, userCount: 0 }
};

export function usePortalAdminMcpConnections({
  currentUserId,
  query,
  status
}: {
  currentUserId: string;
  query: string;
  status: AdminMcpConnectionStatusFilter;
}) {
  const [busyId, setBusyId] = useState("");
  const [data, setData] = useState<AdminMcpConnectionData>(emptyData);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      setData(await loadAdminMcpConnections({ query, signal, status }));
    } catch (caught) {
      if (signal?.aborted) {
        return;
      }
      setData(emptyData);
      setError(caught instanceof Error ? caught.message : "admin_mcp_connections_unavailable");
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [query, status]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [currentUserId, load]);

  const disableConnection = useCallback(async (connectionId: string) => {
    setBusyId(connectionId);
    setError("");
    try {
      await disableAdminMcpConnection(connectionId);
      await load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "admin_mcp_connection_disable_failed");
      return false;
    } finally {
      setBusyId("");
    }
  }, [load]);

  return { busyId, data, disableConnection, error, load, loading };
}
