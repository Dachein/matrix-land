/** Browser Performance entries for inspecting the route's real data wait chain. */
export function recordPortalLoadTiming(name: string, startedAt: number | undefined) {
  if (startedAt === undefined || !globalThis.performance?.measure) return;
  try {
    globalThis.performance.measure(`portal:${name}`, {
      start: startedAt,
      duration: globalThis.performance.now() - startedAt
    });
  } catch {
    // Metrics must never affect page loading on browsers with partial support.
  }
}

const recordedColdRoutes = new Set<string>();

export function recordPortalRouteDataReady(page: string) {
  if (recordedColdRoutes.has(page)) return;
  if (!globalThis.performance?.measure) return;
  try {
    globalThis.performance.measure(`portal:cold-route-data-ready:${page}`, {
      start: 0,
      duration: globalThis.performance.now()
    });
    recordedColdRoutes.add(page);
  } catch {
    // Navigation timing is diagnostic only.
  }
}
