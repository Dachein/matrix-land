import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadPortalData,
  loadPortalDiscussionPage,
  loadPortalHomeApplications,
  loadPortalReadModels,
  clearInitialPortalData,
  consumeInitialPortalData,
  type AuthSession,
  type PortalLoadError,
  type PortalReadModel,
  type PortalReadModelLoadResult
} from "./portalDataLoader";
import {
  currentUserSummaryFromJourney,
  mergePortalCurrentUserSummary
} from "./currentUserSummaryCache";
import type {
  ForumDiscussionPage,
  ForumDiscussionQuery,
  PortalCatalog
} from "../../../../src/shared/types";

const FORUM_INITIAL_PAGE_LIMIT = 20;
const FORUM_LOAD_MORE_LIMIT = 8;
const BACKGROUND_RESOURCES: PortalReadModel[] = ["discussions", "journey"];

export type PortalForumFeedState = {
  hasPendingUpdate: boolean;
  loading: boolean;
  loadingMore: boolean;
  nextCursor?: string;
  pendingCount: number;
  refreshing: boolean;
};

type InternalForumFeedState = PortalForumFeedState & {
  firstPage?: ForumDiscussionPage;
  pendingPage?: ForumDiscussionPage;
  queryKey: string;
};

type PortalDataState = {
  applyPendingDiscussions: () => void;
  auth?: AuthSession;
  catalog?: PortalCatalog;
  degradedResources: PortalReadModel[];
  error?: PortalLoadError;
  forumFeed: PortalForumFeedState;
  homeApplicationsLoading: boolean;
  loadMoreDiscussions: (query?: ForumDiscussionQuery) => Promise<boolean>;
  loading: boolean;
  routeDataLoading: boolean;
  refresh: () => void;
  refreshDiscussions: (
    query?: ForumDiscussionQuery,
    options?: { stage?: boolean }
  ) => Promise<boolean>;
  updateCatalog: (updater: (catalog: PortalCatalog) => PortalCatalog) => void;
};

type DiscussionRefreshRequest = {
  controller: AbortController;
  key: string;
  promise: Promise<boolean>;
};

export function usePortalData({
  authOnly = false,
  backgroundResourcesEnabled = true,
  criticalResources = [],
  deferredResources = [],
  homeApplicationsEnabled = true
}: {
  authOnly?: boolean;
  backgroundResourcesEnabled?: boolean;
  criticalResources?: PortalReadModel[];
  deferredResources?: PortalReadModel[];
  homeApplicationsEnabled?: boolean;
} = {}): PortalDataState {
  const deferredResourceKey = [...new Set(deferredResources)].sort().join(",");
  const criticalResourceKey = [...new Set(criticalResources)].sort().join(",");
  const [refreshKey, setRefreshKey] = useState(0);
  const loadedResourcesRef = useRef(new Set<PortalReadModel>());
  const pendingInitialResourcesRef = useRef(new Set<PortalReadModel>());
  const inFlightRouteResourcesRef = useRef(new Set<PortalReadModel>());
  const homeApplicationsRequestRef = useRef("");
  const discussionRefreshRef = useRef<DiscussionRefreshRequest | undefined>(undefined);
  const loadMoreControllerRef = useRef<AbortController | undefined>(undefined);
  const catalogRef = useRef<PortalCatalog | undefined>(undefined);
  const [forumFeed, setForumFeedState] = useState<InternalForumFeedState>(() => emptyForumFeed(true));
  const forumFeedRef = useRef(forumFeed);
  const criticalResourceKeyRef = useRef(criticalResourceKey);
  criticalResourceKeyRef.current = criticalResourceKey;
  const criticalRoutePending = () => criticalResourceKeyRef.current
    .split(",")
    .some((resource) => pendingInitialResourcesRef.current.has(resource as PortalReadModel)
      || inFlightRouteResourcesRef.current.has(resource as PortalReadModel));
  const [state, setState] = useState<Omit<
    PortalDataState,
    | "applyPendingDiscussions"
    | "forumFeed"
    | "loadMoreDiscussions"
    | "refresh"
    | "refreshDiscussions"
    | "updateCatalog"
  >>({
    degradedResources: [],
    homeApplicationsLoading: false,
    loading: true,
    routeDataLoading: false
  });
  const catalogUserId = state.catalog?.currentUser.id;

  const setForumFeed = useCallback((
    updater: InternalForumFeedState | ((current: InternalForumFeedState) => InternalForumFeedState)
  ) => {
    setForumFeedState((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      forumFeedRef.current = next;
      return next;
    });
  }, []);

  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);
  const updateCatalog = useCallback((updater: (catalog: PortalCatalog) => PortalCatalog) => {
    setState((current) => {
      if (!current.catalog) {
        return current;
      }
      const catalog = updater(current.catalog);
      catalogRef.current = catalog;
      return { ...current, catalog };
    });
  }, []);

  const refreshDiscussions = useCallback((
    query: ForumDiscussionQuery = {},
    options: { stage?: boolean } = {}
  ) => {
    const normalizedQuery = forumPageQuery(query, FORUM_INITIAL_PAGE_LIMIT);
    const queryKey = forumDiscussionQueryKey(normalizedQuery);
    const requestKey = `${options.stage ? "stage" : "replace"}:${queryKey}`;
    if (discussionRefreshRef.current?.key === requestKey) {
      return discussionRefreshRef.current.promise;
    }

    discussionRefreshRef.current?.controller.abort();
    if (!options.stage && forumFeedRef.current.queryKey !== queryKey) {
      loadMoreControllerRef.current?.abort();
    }

    const controller = new AbortController();
    setForumFeed((current) => ({
      ...current,
      hasPendingUpdate: options.stage ? current.hasPendingUpdate : false,
      pendingCount: options.stage ? current.pendingCount : 0,
      pendingPage: options.stage ? current.pendingPage : undefined,
      refreshing: true
    }));
    const promise = loadPortalDiscussionPage(controller.signal, normalizedQuery)
      .then((page) => {
        if (controller.signal.aborted) {
          return false;
        }

        if (options.stage) {
          if (forumFeedRef.current.queryKey !== queryKey) {
            return false;
          }
          if (sameForumPage(forumFeedRef.current.firstPage, page)) {
            setForumFeed((current) => ({
              ...current,
              hasPendingUpdate: false,
              pendingCount: 0,
              pendingPage: undefined
            }));
            return true;
          }

          const currentIds = new Set(catalogRef.current?.discussions.map((discussion) => discussion.id) ?? []);
          const pendingCount = mergeForumPage(page)
            .filter((discussion) => !currentIds.has(discussion.id))
            .length;
          setForumFeed((current) => ({
            ...current,
            hasPendingUpdate: true,
            pendingCount,
            pendingPage: page
          }));
          return true;
        }

        const discussions = mergeForumPage(page);
        setState((current) => {
          if (!current.catalog) {
            return current;
          }
          const catalog = { ...current.catalog, discussions };
          catalogRef.current = catalog;
          return {
            ...current,
            catalog,
            degradedResources: current.degradedResources.filter((resource) => resource !== "discussions")
          };
        });
        setForumFeed({
          ...emptyForumFeed(),
          firstPage: page,
          nextCursor: page.nextCursor,
          queryKey
        });
        return true;
      })
      .catch(() => false)
      .finally(() => {
        if (discussionRefreshRef.current?.promise === promise) {
          discussionRefreshRef.current = undefined;
          setForumFeed((current) => ({
            ...current,
            ...(!options.stage ? { loading: false } : {}),
            refreshing: false
          }));
        }
      });

    discussionRefreshRef.current = { controller, key: requestKey, promise };
    return promise;
  }, [setForumFeed]);

  const loadMoreDiscussions = useCallback(async (query: ForumDiscussionQuery = {}) => {
    const currentFeed = forumFeedRef.current;
    const queryKey = forumDiscussionQueryKey(query);
    if (
      !currentFeed.nextCursor
      || currentFeed.loadingMore
      || currentFeed.queryKey !== queryKey
    ) {
      return false;
    }

    loadMoreControllerRef.current?.abort();
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    setForumFeed((current) => ({ ...current, loadingMore: true }));

    try {
      const page = await loadPortalDiscussionPage(controller.signal, forumPageQuery({
        ...query,
        cursor: currentFeed.nextCursor
      }, FORUM_LOAD_MORE_LIMIT));
      if (controller.signal.aborted || forumFeedRef.current.queryKey !== queryKey) {
        return false;
      }

      setState((current) => {
        if (!current.catalog) {
          return current;
        }
        const discussions = uniqueDiscussions([
          ...current.catalog.discussions,
          ...page.discussions
        ]);
        const catalog = { ...current.catalog, discussions };
        catalogRef.current = catalog;
        return { ...current, catalog };
      });
      setForumFeed((current) => ({ ...current, nextCursor: page.nextCursor }));
      return true;
    } catch {
      return false;
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = undefined;
        setForumFeed((current) => ({ ...current, loadingMore: false }));
      }
    }
  }, [setForumFeed]);

  const applyPendingDiscussions = useCallback(() => {
    const currentFeed = forumFeedRef.current;
    const pendingPage = currentFeed.pendingPage;
    if (!pendingPage) {
      return;
    }

    const previousFirstPageIds = new Set(
      currentFeed.firstPage ? mergeForumPage(currentFeed.firstPage).map((discussion) => discussion.id) : []
    );
    setState((current) => {
      if (!current.catalog) {
        return current;
      }
      const loadedOlderDiscussions = current.catalog.discussions
        .filter((discussion) => !previousFirstPageIds.has(discussion.id));
      const discussions = uniqueDiscussions([
        ...mergeForumPage(pendingPage),
        ...loadedOlderDiscussions
      ]);
      const catalog = { ...current.catalog, discussions };
      catalogRef.current = catalog;
      return { ...current, catalog };
    });
    setForumFeed((current) => ({
      ...current,
      firstPage: pendingPage,
      hasPendingUpdate: false,
      nextCursor: pendingPage.nextCursor,
      pendingCount: 0,
      pendingPage: undefined
    }));
  }, [setForumFeed]);

  useEffect(() => {
    const initialRequest = consumeInitialPortalData(authOnly);
    const controller = initialRequest?.controller ?? new AbortController();
    let disposed = false;
    discussionRefreshRef.current?.controller.abort();
    loadMoreControllerRef.current?.abort();
    setState((current) => ({
      ...current,
      degradedResources: [],
      error: undefined,
      homeApplicationsLoading: false,
      loading: true,
      routeDataLoading: false
    }));
    loadedResourcesRef.current = new Set();
    pendingInitialResourcesRef.current = new Set(initialRequest?.routeResources ?? []);
    inFlightRouteResourcesRef.current = new Set();
    homeApplicationsRequestRef.current = "";
    setForumFeed(emptyForumFeed(!authOnly));

    const initialDataRequest = initialRequest?.promise ?? loadPortalData(controller.signal, fetch, { authOnly });
    let bootstrapLoaded = false;
    const completedRouteResults = new Map<PortalReadModel, PortalReadModelLoadResult>();
    const applyInitialRouteResult = (resource: PortalReadModel, result: PortalReadModelLoadResult) => {
      if (disposed || controller.signal.aborted) return;
      completedRouteResults.set(resource, result);
      if (!bootstrapLoaded) return;
      pendingInitialResourcesRef.current.delete(resource);
      if (!result.degradedResources.includes(resource) && !result.unauthorized) {
        loadedResourcesRef.current.add(resource);
      }
      if (result.forumPage) {
        setForumFeed({
          ...emptyForumFeed(),
          firstPage: result.forumPage,
          nextCursor: result.forumPage.nextCursor
        });
      } else if (resource === "discussions") {
        setForumFeed((current) => ({ ...current, loading: false }));
      }
      setState((current) => {
        if (result.unauthorized) {
          return {
            ...current,
            auth: current.auth ? { ...current.auth, authenticated: false, configured: true } : current.auth,
            catalog: undefined,
            routeDataLoading: false
          };
        }
        if (!current.catalog) {
          return { ...current, routeDataLoading: criticalRoutePending() };
        }

        const catalog = mergePortalReadModelResult(current.catalog, result);
        catalogRef.current = catalog;
        return {
          ...current,
          catalog,
          degradedResources: Array.from(new Set([
            ...current.degradedResources.filter((item) => item !== resource),
            ...result.degradedResources
          ])),
          routeDataLoading: criticalRoutePending()
        };
      });
    };
    initialRequest?.routeRequests.forEach(({ resource, promise }) => {
      void promise.then((result) => applyInitialRouteResult(resource, result));
    });
    void initialDataRequest.then((result) => {
      if (disposed || controller.signal.aborted) return;
      clearInitialPortalData(initialRequest);

      bootstrapLoaded = true;
      const { forumPage, ...portalResult } = result;
      loadedResourcesRef.current = new Set();
      let catalog = portalResult.catalog;
      let routeUnauthorized = false;
      const degradedResources = [...portalResult.degradedResources];
      let initialForumPage = forumPage;
      completedRouteResults.forEach((routeResult, resource) => {
        pendingInitialResourcesRef.current.delete(resource);
        if (!routeResult.degradedResources.includes(resource) && !routeResult.unauthorized) {
          loadedResourcesRef.current.add(resource);
        }
        routeUnauthorized ||= routeResult.unauthorized;
        if (catalog && !routeResult.unauthorized) {
          catalog = mergePortalReadModelResult(catalog, routeResult);
        }
        initialForumPage = routeResult.forumPage ?? initialForumPage;
        degradedResources.push(...routeResult.degradedResources);
      });
      if (routeUnauthorized && catalog) {
        portalResult.auth = portalResult.auth
          ? { ...portalResult.auth, authenticated: false, configured: true }
          : portalResult.auth;
        portalResult.catalog = undefined;
      } else {
        portalResult.catalog = catalog;
      }
      setState((current) => {
        const nextCatalog = routeUnauthorized ? undefined : catalog ?? (authOnly ? current.catalog : undefined);
        catalogRef.current = nextCatalog;
        return {
          ...portalResult,
          catalog: nextCatalog,
          degradedResources: Array.from(new Set(degradedResources)),
          homeApplicationsLoading: false,
          loading: false,
          routeDataLoading: criticalRoutePending()
        };
      });
      setForumFeed(!routeUnauthorized && initialForumPage
        ? {
            ...emptyForumFeed(),
            firstPage: initialForumPage,
            nextCursor: initialForumPage.nextCursor
          }
        : emptyForumFeed(!authOnly));
    });

    return () => {
      disposed = true;
      if (!initialRequest) {
        controller.abort();
      }
    };
  }, [authOnly, refreshKey, setForumFeed]);

  useEffect(() => {
    if (authOnly || !homeApplicationsEnabled || state.loading || !catalogUserId) {
      setState((current) => current.homeApplicationsLoading
        ? { ...current, homeApplicationsLoading: false }
        : current);
      return undefined;
    }

    const requestKey = `${refreshKey}:${catalogUserId}`;
    if (homeApplicationsRequestRef.current === requestKey) {
      return undefined;
    }
    homeApplicationsRequestRef.current = requestKey;

    const controller = new AbortController();
    let completed = false;
    setState((current) => ({ ...current, homeApplicationsLoading: true }));
    void loadPortalHomeApplications(controller.signal, []).then((result) => {
      if (controller.signal.aborted) {
        return;
      }
      completed = true;

      setState((current) => {
        if (result.unauthorized) {
          return {
            ...current,
            auth: current.auth ? { ...current.auth, authenticated: false, configured: true } : current.auth,
            catalog: undefined,
            homeApplicationsLoading: false
          };
        }
        if (!current.catalog) {
          return { ...current, homeApplicationsLoading: false };
        }

        const catalog = mergePortalReadModelResult(current.catalog, result);
        catalogRef.current = catalog;
        return {
          ...current,
          catalog,
          degradedResources: Array.from(new Set([
            ...current.degradedResources.filter((resource) => resource !== "apps" && resource !== "hub"),
            ...result.degradedResources
          ])),
          homeApplicationsLoading: false
        };
      });
    });

    return () => {
      controller.abort();
      if (!completed && homeApplicationsRequestRef.current === requestKey) {
        homeApplicationsRequestRef.current = "";
      }
    };
  }, [
    authOnly,
    catalogUserId,
    homeApplicationsEnabled,
    refreshKey,
    state.loading
  ]);

  useEffect(() => {
    if (authOnly || state.loading || !catalogUserId) {
      return undefined;
    }

    const requestedResources = deferredResourceKey
      .split(",")
      .filter((resource): resource is PortalReadModel => Boolean(resource));
    const missingRouteResources = requestedResources.filter((resource) => (
      !loadedResourcesRef.current.has(resource)
      && !pendingInitialResourcesRef.current.has(resource)
      && !inFlightRouteResourcesRef.current.has(resource)
    ));
    if (missingRouteResources.length === 0) {
      const pending = criticalRoutePending();
      setState((current) => current.routeDataLoading !== pending
        ? { ...current, routeDataLoading: pending }
        : current);
      return undefined;
    }

    const controller = new AbortController();
    missingRouteResources.forEach((resource) => inFlightRouteResourcesRef.current.add(resource));
    setState((current) => ({ ...current, routeDataLoading: criticalRoutePending() }));
    missingRouteResources.forEach((resource) => {
      void loadPortalReadModels(controller.signal, [resource]).then((result) => {
        if (controller.signal.aborted) return;
        inFlightRouteResourcesRef.current.delete(resource);
        if (!result.degradedResources.includes(resource) && !result.unauthorized) {
          loadedResourcesRef.current.add(resource);
        }
        if (result.forumPage) {
          setForumFeed({
            ...emptyForumFeed(),
            firstPage: result.forumPage,
            nextCursor: result.forumPage.nextCursor
          });
        } else if (resource === "discussions") {
          setForumFeed((current) => ({ ...current, loading: false }));
        }
        setState((current) => {
          if (result.unauthorized) {
            return {
              ...current,
              auth: current.auth ? { ...current.auth, authenticated: false, configured: true } : current.auth,
              catalog: undefined,
              routeDataLoading: false
            };
          }
          if (!current.catalog) return { ...current, routeDataLoading: criticalRoutePending() };

          const catalog = mergePortalReadModelResult(current.catalog, result);
          catalogRef.current = catalog;
          return {
            ...current,
            catalog,
            degradedResources: Array.from(new Set([
              ...current.degradedResources.filter((item) => item !== resource),
              ...result.degradedResources
            ])),
            routeDataLoading: criticalRoutePending()
          };
        });
      }).catch(() => {
        if (controller.signal.aborted) return;
        inFlightRouteResourcesRef.current.delete(resource);
        if (resource === "discussions") {
          setForumFeed((current) => ({ ...current, loading: false }));
        }
        setState((current) => ({ ...current, routeDataLoading: criticalRoutePending() }));
      });
    });

    return () => {
      controller.abort();
      missingRouteResources.forEach((resource) => inFlightRouteResourcesRef.current.delete(resource));
    };
  }, [authOnly, catalogUserId, criticalResourceKey, deferredResourceKey, setForumFeed, state.loading]);

  useEffect(() => {
    if (authOnly || !backgroundResourcesEnabled || state.loading || !catalogUserId) {
      return undefined;
    }

    const missingResources = BACKGROUND_RESOURCES
      .filter((resource) => !loadedResourcesRef.current.has(resource));
    if (missingResources.length === 0) {
      return undefined;
    }

    const controller = new AbortController();
    const backgroundTimer = window.setTimeout(() => {
      void loadPortalReadModels(controller.signal, missingResources).then((result) => {
        if (controller.signal.aborted) {
          return;
        }

        missingResources.forEach((resource) => {
          if (!result.degradedResources.includes(resource) && !result.unauthorized) {
            loadedResourcesRef.current.add(resource);
          }
        });
        if (result.forumPage) {
          setForumFeed({
            ...emptyForumFeed(),
            firstPage: result.forumPage,
            nextCursor: result.forumPage.nextCursor
          });
        } else if (missingResources.includes("discussions")) {
          setForumFeed((current) => ({ ...current, loading: false }));
        }
        setState((current) => {
          if (result.unauthorized) {
            return {
              ...current,
              auth: current.auth ? { ...current.auth, authenticated: false, configured: true } : current.auth,
              catalog: undefined
            };
          }
          if (!current.catalog) {
            return current;
          }

          const catalog = mergePortalReadModelResult(current.catalog, result);
          catalogRef.current = catalog;
          return {
            ...current,
            catalog,
            degradedResources: Array.from(new Set([
              ...current.degradedResources.filter((resource) => !missingResources.includes(resource)),
              ...result.degradedResources
            ]))
          };
        });
      }).catch(() => {
        if (!controller.signal.aborted && missingResources.includes("discussions")) {
          setForumFeed((current) => ({ ...current, loading: false }));
        }
      });
    }, 350);

    return () => {
      window.clearTimeout(backgroundTimer);
      controller.abort();
    };
  }, [authOnly, backgroundResourcesEnabled, catalogUserId, setForumFeed, state.loading]);

  useEffect(() => () => {
    discussionRefreshRef.current?.controller.abort();
    loadMoreControllerRef.current?.abort();
  }, []);

  return {
    ...state,
    applyPendingDiscussions,
    forumFeed: {
      hasPendingUpdate: forumFeed.hasPendingUpdate,
      loading: forumFeed.loading,
      loadingMore: forumFeed.loadingMore,
      nextCursor: forumFeed.nextCursor,
      pendingCount: forumFeed.pendingCount,
      refreshing: forumFeed.refreshing
    },
    loadMoreDiscussions,
    refresh,
    refreshDiscussions,
    updateCatalog
  };
}

function emptyForumFeed(loading = false): InternalForumFeedState {
  return {
    hasPendingUpdate: false,
    loading,
    loadingMore: false,
    pendingCount: 0,
    queryKey: forumDiscussionQueryKey({}),
    refreshing: false
  };
}

function forumPageQuery(query: ForumDiscussionQuery, limit: number): ForumDiscussionQuery {
  return {
    category: query.category?.trim() || undefined,
    cursor: query.cursor?.trim() || undefined,
    limit,
    owner: query.owner === "mine" ? "mine" : "all",
    query: query.query?.trim() || undefined
  };
}

export function forumDiscussionQueryKey(query: ForumDiscussionQuery) {
  return JSON.stringify([
    query.category?.trim() || "",
    query.owner === "mine" ? "mine" : "all",
    query.query?.trim() || ""
  ]);
}

function mergeForumPage(page: ForumDiscussionPage) {
  return [...page.pinnedDiscussions, ...page.discussions];
}

function sameForumPage(left: ForumDiscussionPage | undefined, right: ForumDiscussionPage) {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}

function uniqueDiscussions(discussions: PortalCatalog["discussions"]) {
  const seen = new Set<string>();
  return discussions.filter((discussion) => {
    if (seen.has(discussion.id)) {
      return false;
    }
    seen.add(discussion.id);
    return true;
  });
}

function mergePortalReadModelResult(
  catalog: PortalCatalog,
  result: Awaited<ReturnType<typeof loadPortalReadModels>>
) {
  const patched = {
    ...catalog,
    ...result.patch,
    ...(result.currentUser
      ? {
          currentUser: {
            ...catalog.currentUser,
            ...result.currentUser,
            identity: catalog.currentUser.identity
          }
        }
      : {})
  };
  const summary = result.currentUserSummary
    ?? result.currentUser?.status
    ?? (result.patch.journey ? currentUserSummaryFromJourney(result.patch.journey) : undefined);
  return summary ? mergePortalCurrentUserSummary(patched, summary) : patched;
}
