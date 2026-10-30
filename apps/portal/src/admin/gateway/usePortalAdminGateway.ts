import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAdminUsageExportLink,
  deleteAdminGatewayToken,
  loadAdminGatewayAllocations,
  loadAdminGatewayUsage,
  setAdminGatewayTokenStatus,
  updateAdminGatewayToken,
  updateAdminGatewayUserLimit
} from "./api";
import type {
  AdminGatewayGroupBy,
  AdminGatewaySection,
  AdminGatewayViewData,
  AdminTokenDraft,
  AdminUserLimitDraft
} from "./types";
import {
  invalidateMemoryResources,
  loadMemoryResource
} from "../../../../../src/portal/lib/memoryResourceCache";

const ADMIN_GATEWAY_CACHE_MAX_AGE_MS = 30 * 1000;

export function usePortalAdminGateway(userId: string, section: AdminGatewaySection) {
  const [data, setData] = useState<AdminGatewayViewData>();
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [groupBy, setGroupBy] = useState<AdminGatewayGroupBy>("model");
  const [range, setRange] = useState(currentMonthRange);
  const loadVersion = useRef(0);
  const cachePrefix = `admin-gateway:${userId}:`;

  const load = useCallback(async (forceRefresh = false) => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError("");

    const loadAllocations = () => loadMemoryResource({
      forceRefresh,
      key: `${cachePrefix}allocations`,
      load: () => loadAdminGatewayAllocations({}),
      maxAgeMs: ADMIN_GATEWAY_CACHE_MAX_AGE_MS
    });
    try {
      if (section === "usage") {
        const usage = await loadMemoryResource({
          forceRefresh,
          key: `${cachePrefix}usage:${range.from}:${range.to}:${groupBy}`,
          load: () => loadAdminGatewayUsage({ ...range, groupBy }),
          maxAgeMs: ADMIN_GATEWAY_CACHE_MAX_AGE_MS
        });
        if (version === loadVersion.current) {
          setData({ usage });
        }
      } else {
        const allocations = await loadAllocations();
        if (version === loadVersion.current) {
          // Token and allocation inventory must stay independent from usage
          // analytics. Loading either page must never trigger LiteLLM's
          // global daily-activity aggregation in the background.
          setData({ allocations });
        }
      }
    } catch (loadError) {
      if (version === loadVersion.current) {
        setError(errorMessage(loadError, "admin_gateway_load_failed"));
      }
    } finally {
      if (version === loadVersion.current) {
        setLoading(false);
      }
    }
  }, [cachePrefix, groupBy, range, section]);

  useEffect(() => {
    void load();
  }, [load]);

  const runMutation = useCallback(async (id: string, action: () => Promise<unknown>, successMessage: string) => {
    setBusyId(id);
    setError("");
    setMessage("");

    try {
      await action();
      invalidateMemoryResources(cachePrefix);
      setMessage(successMessage);
      await load(true);
      return true;
    } catch (mutationError) {
      setError(errorMessage(mutationError, "admin_gateway_mutation_failed"));
      return false;
    } finally {
      setBusyId("");
    }
  }, [cachePrefix, load]);

  const saveToken = useCallback((tokenId: string, draft: AdminTokenDraft) => (
    runMutation(tokenId, () => updateAdminGatewayToken(tokenId, draft), "token_saved")
  ), [runMutation]);

  const setTokenStatus = useCallback((tokenId: string, status: "active" | "suspended") => (
    runMutation(tokenId, () => setAdminGatewayTokenStatus(tokenId, status), status === "active" ? "token_activated" : "token_suspended")
  ), [runMutation]);

  const removeToken = useCallback((tokenId: string) => (
    runMutation(tokenId, () => deleteAdminGatewayToken(tokenId), "token_deleted")
  ), [runMutation]);

  const saveUserLimit = useCallback((targetUserId: string, draft: AdminUserLimitDraft) => (
    runMutation(targetUserId, () => updateAdminGatewayUserLimit(targetUserId, draft), "user_limit_saved")
  ), [runMutation]);

  const exportUsage = useCallback(async () => {
    setBusyId("export");
    setError("");

    try {
      const payload = await createAdminUsageExportLink({ ...range });
      window.location.assign(payload.url);
    } catch (exportError) {
      setError(errorMessage(exportError, "admin_gateway_export_failed"));
    } finally {
      setBusyId("");
    }
  }, [range]);

  return {
    busyId,
    data,
    error,
    exportUsage,
    groupBy,
    load,
    loading,
    message,
    range,
    ready: section === "usage" ? Boolean(data?.usage) : Boolean(data?.allocations),
    removeToken,
    saveToken,
    saveUserLimit,
    setGroupBy,
    setRange,
    setTokenStatus
  };
}

function currentMonthRange() {
  const now = new Date();
  return {
    from: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`,
    to: now.toISOString().slice(0, 10)
  };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
