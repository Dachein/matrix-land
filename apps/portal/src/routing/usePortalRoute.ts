import { useCallback, useEffect, useState } from "react";
import { browserUrlForPortalRoute, parsePortalRoute, type PortalRoute } from "./portalRoutes";

export function usePortalRoute() {
  const [route, setRoute] = useState<PortalRoute>(() => parsePortalRoute(currentRouteLocation()));

  useEffect(() => {
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    const syncRoute = () => {
      const location = currentRouteLocation();
      const nextRoute = parsePortalRoute(location);
      setRoute(nextRoute);
    };
    window.addEventListener("popstate", syncRoute);
    return () => {
      window.history.scrollRestoration = previousScrollRestoration;
      window.removeEventListener("popstate", syncRoute);
    };
  }, []);

  const navigate = useCallback((nextRoute: PortalRoute, options?: { replace?: boolean }) => {
    const nextUrl = browserUrlForPortalRoute(nextRoute, window.location.pathname);

    if (options?.replace) {
      window.history.replaceState({}, "", nextUrl);
    } else {
      window.history.pushState({}, "", nextUrl);
    }

    setRoute(nextRoute);

    if (nextRoute.page !== "landing") {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }, []);

  return { navigate, route };
}

function currentRouteLocation() {
  return `${window.location.pathname}${window.location.search}`;
}
