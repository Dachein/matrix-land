import { useEffect, useMemo, useState } from "react";
import type { DiscussionContentPlugin, PortalApp } from "../../../../src/shared/types";
import { loadPortalApps } from "./portalDataLoader";

export function usePortalLinkedApps(
  catalogApps: PortalApp[],
  contentPlugins: DiscussionContentPlugin[] | undefined
) {
  const targetIds = useMemo(() => Array.from(new Set(
    (contentPlugins ?? [])
      .filter((plugin) => plugin.targetType === "app")
      .map((plugin) => plugin.targetId.trim())
      .filter(Boolean)
  )), [contentPlugins]);
  const targetKey = targetIds.join("\u0000");
  const [loadedApps, setLoadedApps] = useState<PortalApp[]>([]);

  useEffect(() => {
    const catalogAppIds = new Set(catalogApps.map((app) => app.id));
    const missingTargetIds = targetKey
      .split("\u0000")
      .filter((targetId) => targetId && !catalogAppIds.has(targetId));

    if (missingTargetIds.length === 0) {
      setLoadedApps([]);
      return undefined;
    }

    const controller = new AbortController();
    void loadPortalApps(controller.signal, missingTargetIds)
      .then((apps) => {
        if (!controller.signal.aborted) {
          setLoadedApps(apps);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadedApps([]);
        }
      });

    return () => controller.abort();
  }, [catalogApps, targetKey]);

  return useMemo(() => new Map(
    [...catalogApps, ...loadedApps].map((app) => [app.id, app])
  ), [catalogApps, loadedApps]);
}
