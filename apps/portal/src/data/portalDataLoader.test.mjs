import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadDataLoader() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-portal-data-loader-"));
  const outfile = join(outdir, "portal-data-loader.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./portalDataLoader.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "node"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status
  });
}

function catalogFixture() {
  return {
    activityEvents: [{ id: "catalog-activity" }],
    apps: [{ id: "catalog-app" }],
    audit: [],
    categories: [],
    currentUser: { id: "user-1" },
    dataServices: [],
    discussions: [{ id: "catalog-topic" }],
    hubListings: [],
    journey: { level: { key: "explorer" } },
    publicationListings: [],
    mcpTools: [],
    portal: {
      name: "Production workspace"
    },
    reviewQueue: [],
    skills: [],
    usage: {}
  };
}

function authenticatedSession() {
  return {
    authenticated: true,
    configured: true,
    emailLoginConfigured: true,
    emailLoginUrl: "/auth/email/login",
    loginUrl: "/auth/login"
  };
}

describe("Portal production data loader", () => {
  it("starts the initial data request before the locale provider consumes it", async () => {
    const { clearInitialPortalData, consumeInitialPortalData, preloadInitialPortalData } = await loadDataLoader();
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse({ auth: authenticatedSession(), catalog: catalogFixture() });
    };

    try {
      preloadInitialPortalData(false);
      assert.deepEqual(calls, ["/api/home-bootstrap"]);

      const firstConsumer = consumeInitialPortalData(false);
      const strictModeReplay = consumeInitialPortalData(false);
      assert.strictEqual(strictModeReplay, firstConsumer);
      assert.equal((await firstConsumer.promise).catalog?.currentUser.id, "user-1");
      clearInitialPortalData(firstConsumer);
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("starts initial route data in parallel with the portal bootstrap", async () => {
    const { consumeInitialPortalData, preloadInitialPortalData } = await loadDataLoader();
    const originalFetch = globalThis.fetch;
    const calls = [];
    let resolveBootstrap;
    globalThis.fetch = async (input) => {
      const path = String(input);
      calls.push(path);
      if (path === "/api/home-bootstrap") {
        return new Promise((resolve) => { resolveBootstrap = resolve; });
      }
      if (path === "/api/apps") return jsonResponse({ apps: [] });
      if (path === "/api/publication/hub-listings") return jsonResponse({ hubListings: [] });
      throw new Error(`Unexpected request: ${path}`);
    };

    try {
      preloadInitialPortalData(false, ["apps", "hub"]);
      assert.deepEqual(calls.sort(), [
        "/api/apps",
        "/api/home-bootstrap",
        "/api/publication/hub-listings"
      ]);
      const request = consumeInitialPortalData(false);
      assert.deepEqual(request.routeResources, ["apps", "hub"]);
      assert.deepEqual((await request.routePromise).patch, { apps: [], hubListings: [] });
      resolveBootstrap(jsonResponse({ auth: authenticatedSession(), catalog: catalogFixture() }));
      assert.equal((await request.promise).catalog.currentUser.id, "user-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("makes each preloaded route read model available without waiting for its peers", async () => {
    const { consumeInitialPortalData, preloadInitialPortalData } = await loadDataLoader();
    const originalFetch = globalThis.fetch;
    let resolveApps;
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/api/home-bootstrap") {
        return jsonResponse({ auth: authenticatedSession(), catalog: catalogFixture() });
      }
      if (path === "/api/publication/hub-listings") {
        return jsonResponse({ hubListings: [{ id: "hub-fast" }] });
      }
      if (path === "/api/apps") {
        return new Promise((resolve) => { resolveApps = resolve; });
      }
      throw new Error(`Unexpected request: ${path}`);
    };

    try {
      preloadInitialPortalData(false, ["apps", "hub"]);
      const request = consumeInitialPortalData(false);
      const hubRequest = request.routeRequests.find(({ resource }) => resource === "hub");
      const hubResult = await hubRequest.promise;
      assert.equal(hubResult.patch.hubListings[0].id, "hub-fast");
      assert.equal(request.routeRequests.length, 2);
      resolveApps(jsonResponse({ apps: [{ id: "app-slow" }] }));
      assert.equal((await request.routePromise).patch.apps[0].id, "app-slow");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("cancels a startup preload if the route changes to a different auth mode", async () => {
    const { consumeInitialPortalData, preloadInitialPortalData } = await loadDataLoader();
    const originalFetch = globalThis.fetch;
    let requestSignal;
    globalThis.fetch = async (_input, init) => {
      requestSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    };

    try {
      preloadInitialPortalData(false);
      assert.equal(consumeInitialPortalData(true), undefined);
      assert.equal(requestSignal.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("loads and validates the lightweight forum refresh payload", async () => {
    const { ApiResponseError, loadPortalDiscussions } = await loadDataLoader();
    const signal = new AbortController().signal;

    const discussions = await loadPortalDiscussions(
      signal,
      async () => jsonResponse({
        discussions: [{ id: "fresh-topic" }],
        pinnedDiscussions: [{ id: "pinned-topic" }]
      })
    );
    assert.deepEqual(discussions.map((discussion) => discussion.id), ["pinned-topic", "fresh-topic"]);

    await assert.rejects(
      () => loadPortalDiscussions(signal, async () => jsonResponse({ discussions: {}, pinnedDiscussions: [] })),
      (error) => error instanceof ApiResponseError && error.status === 502
    );
  });

  it("encodes forum cursor pagination and server-side filters", async () => {
    const { loadPortalDiscussionPage } = await loadDataLoader();
    let requestedPath = "";
    let requestedInit;
    const page = await loadPortalDiscussionPage(
      new AbortController().signal,
      {
        category: "ai-exploration",
        cursor: "cursor-1",
        limit: 8,
        owner: "mine",
        query: "agent workflow"
      },
      async (input, init) => {
        requestedPath = String(input);
        requestedInit = init;
        return jsonResponse({
          discussions: [{ id: "page-topic" }],
          nextCursor: "cursor-2",
          pinnedDiscussions: []
        });
      }
    );

    assert.equal(
      requestedPath,
      "/api/forum/topics?category=ai-exploration&cursor=cursor-1&limit=8&owner=mine&q=agent+workflow"
    );
    assert.equal(requestedInit.cache, "no-store");
    assert.equal(page.nextCursor, "cursor-2");
  });

  it("fails closed when the home bootstrap cannot be verified", async () => {
    const { loadPortalData } = await loadDataLoader();
    const result = await loadPortalData(new AbortController().signal, async () => {
      throw new TypeError("network unavailable");
    });

    assert.equal(result.catalog, undefined);
    assert.equal(result.auth, undefined);
    assert.equal(result.error?.scope, "catalog");
  });

  it("exits the boot skeleton when the bootstrap request stalls", async () => {
    const { loadPortalData } = await loadDataLoader();
    let requestSignal;
    const startedAt = Date.now();
    const result = await loadPortalData(
      new AbortController().signal,
      async (_input, init) => {
        requestSignal = init.signal;
        return new Promise(() => {});
      },
      { bootstrapTimeoutMs: 20 }
    );

    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(requestSignal.aborted, true);
    assert.equal(result.error?.scope, "catalog");
    assert.equal(result.catalog, undefined);
  });

  it("does not substitute fixture data when the production catalog fails", async () => {
    const { loadPortalData } = await loadDataLoader();
    const result = await loadPortalData(new AbortController().signal, async (input) => {
      const path = String(input);
      return path === "/api/auth/session"
        ? jsonResponse(authenticatedSession())
        : jsonResponse({ error: "unavailable" }, 503);
    });

    assert.equal(result.catalog, undefined);
    assert.equal(result.error?.scope, "catalog");
    assert.equal(result.error?.status, 503);
  });

  it("loads only the auth shell for a standalone QA runtime", async () => {
    const { loadPortalData } = await loadDataLoader();
    const calls = [];
    const result = await loadPortalData(
      new AbortController().signal,
      async (input) => {
        calls.push(String(input));
        return jsonResponse(authenticatedSession());
      },
      { authOnly: true }
    );

    assert.deepEqual(calls, ["/api/auth/session"]);
    assert.equal(result.auth?.authenticated, true);
    assert.equal(result.auth?.emailLoginConfigured, true);
    assert.equal(result.auth?.emailLoginUrl, "/auth/email/login");
    assert.equal(result.catalog, undefined);
    assert.deepEqual(result.degradedResources, []);
  });

  it("renders from one bootstrap request before loading all accessible home Apps", async () => {
    const { loadPortalData, loadPortalHomeApplications } = await loadDataLoader();
    const calls = [];
    const fetchImpl = async (input) => {
      const path = String(input);
      calls.push(path);
      if (path === "/api/home-bootstrap") {
        return jsonResponse({ auth: authenticatedSession(), catalog: catalogFixture() });
      }
      if (path === "/api/apps") return jsonResponse({ apps: [{ id: "live-home-app" }] });
      if (path === "/api/publication/hub-listings?type=app") {
        return jsonResponse({ hubListings: [{ id: "visible-home-listing" }] });
      }
      if (path === "/api/forum/topics") return jsonResponse({
        discussions: [{ id: "live-topic" }],
        pinnedDiscussions: []
      });
      if (path === "/api/me") return jsonResponse({ journey: { level: { key: "explorer" } }, me: { id: "user-1" } });
      return jsonResponse({ events: [{ id: "live-activity" }] });
    };
    const result = await loadPortalData(new AbortController().signal, fetchImpl);

    assert.deepEqual(result.degradedResources, []);
    assert.equal(result.catalog?.apps[0]?.id, "catalog-app");
    assert.equal(result.catalog?.discussions[0]?.id, "catalog-topic");
    assert.equal(result.catalog?.journey.level.key, "explorer");
    assert.deepEqual(calls, ["/api/home-bootstrap"]);

    const homeResult = await loadPortalHomeApplications(
      new AbortController().signal,
      [],
      fetchImpl
    );
    assert.equal(homeResult.patch.apps[0]?.id, "live-home-app");
    assert.equal(homeResult.patch.hubListings[0]?.id, "visible-home-listing");
    assert.equal(calls.includes("/api/forum/topics"), false);
    assert.equal(calls.includes("/api/activity/events?scenario=community&limit=10"), false);
    assert.equal(calls.includes("/api/journey"), false);
    assert.equal(calls.includes("/api/skills"), false);
    assert.equal(calls.includes("/api/publication/listings"), false);
    assert.equal(calls.includes("/api/apps"), true);
    assert.equal(calls.includes("/api/publication/hub-listings?type=app"), true);
  });

  it("loads current Apps from their dedicated endpoints without requesting Hub Listings", async () => {
    const { loadPortalApps } = await loadDataLoader();
    const calls = [];
    const apps = await loadPortalApps(
      new AbortController().signal,
      ["app-2", "app-1", "app-2"],
      async (input) => {
        calls.push(String(input));
        return jsonResponse({ app: { id: String(input).endsWith("app-2") ? "app-2" : "app-1" } });
      }
    );

    assert.deepEqual(calls, ["/api/apps/app-2", "/api/apps/app-1"]);
    assert.deepEqual(apps.map((app) => app.id), ["app-2", "app-1"]);
  });

  it("requests only ten community activity events when the activity read model is loaded", async () => {
    const { loadPortalReadModels } = await loadDataLoader();
    const calls = [];
    await loadPortalReadModels(
      new AbortController().signal,
      ["activity"],
      async (input) => {
        calls.push(String(input));
        return jsonResponse({ events: [] });
      }
    );

    assert.deepEqual(calls, ["/api/activity/events?scenario=community&limit=10"]);
  });

  it("reports an expired session while home Apps load in the background", async () => {
    const { loadPortalHomeApplications } = await loadDataLoader();
    const result = await loadPortalHomeApplications(new AbortController().signal, [], async (input) => {
      const path = String(input);
      if (path === "/api/apps") return jsonResponse({ error: "unauthorized" }, 401);
      if (path === "/api/publication/hub-listings?type=app") return jsonResponse({ hubListings: [] });
      return jsonResponse({ error: "unexpected" }, 500);
    });

    assert.equal(result.unauthorized, true);
  });

  it("stops the Home application placeholder when one companion request stalls", async () => {
    const { loadPortalHomeApplications } = await loadDataLoader();
    let stalledSignal;
    const result = await loadPortalHomeApplications(
      new AbortController().signal,
      [],
      async (input, init) => {
        if (String(input) === "/api/apps") return jsonResponse({ apps: [{ id: "app-fast" }] });
        stalledSignal = init.signal;
        return new Promise(() => {});
      },
      { timeoutMs: 20 }
    );

    assert.equal(stalledSignal.aborted, true);
    assert.equal(result.patch.apps[0].id, "app-fast");
    assert.deepEqual(result.degradedResources, ["hub"]);
  });

  it("loads full market resources only when a route requests them", async () => {
    const { loadPortalReadModels } = await loadDataLoader();
    const calls = [];
    const result = await loadPortalReadModels(
      new AbortController().signal,
      ["apps", "skills", "hub"],
      async (input) => {
        const path = String(input);
        calls.push(path);
        if (path === "/api/apps") return jsonResponse({ apps: [{ id: "app-1" }] });
        if (path === "/api/skills") return jsonResponse({ skills: [{ id: "skill-1" }] });
        return jsonResponse({ hubListings: [{ id: "hub-1" }] });
      }
    );

    assert.deepEqual(calls.sort(), [
      "/api/apps",
      "/api/publication/hub-listings",
      "/api/skills"
    ]);
    assert.equal(result.patch.apps[0].id, "app-1");
    assert.equal(result.patch.skills[0].id, "skill-1");
    assert.equal(result.patch.hubListings[0].id, "hub-1");
  });

  it("uses the compact admin review endpoint with a bounded longer deadline", async () => {
    const { loadPortalReadModels } = await loadDataLoader();
    const deadlines = [];
    const paths = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...args) => {
      deadlines.push(ms);
      return originalSetTimeout(callback, ms, ...args);
    };
    try {
      const fetcher = async (input) => {
        paths.push(String(input));
        return jsonResponse({ publicationListings: [{ id: "review-1" }] });
      };
      const result = await loadPortalReadModels(new AbortController().signal, ["reviewPublication"], fetcher);
      assert.deepEqual(result.patch.publicationListings, [{ id: "review-1" }]);
      await loadPortalReadModels(new AbortController().signal, ["publication"], fetcher);
      await loadPortalReadModels(new AbortController().signal, ["reviewPublication"], fetcher, { timeoutMs: 20 });
      assert.deepEqual(paths, ["/api/publication/listings?view=review", "/api/publication/listings", "/api/publication/listings?view=review"]);
      assert.deepEqual(deadlines, [30_000, 30_000, 20]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("bounds a stalled read model and keeps results from independent models", async () => {
    const { loadPortalReadModels } = await loadDataLoader();
    let stalledSignal;
    const startedAt = Date.now();
    const result = await loadPortalReadModels(
      new AbortController().signal,
      ["apps", "hub"],
      async (input, init) => {
        if (String(input) === "/api/apps") {
          stalledSignal = init.signal;
          return new Promise(() => {});
        }
        return jsonResponse({ hubListings: [{ id: "hub-fast" }] });
      },
      { timeoutMs: 20 }
    );

    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(stalledSignal.aborted, true);
    assert.deepEqual(result.degradedResources, ["apps"]);
    assert.equal(result.patch.hubListings[0].id, "hub-fast");
  });

  it("loads the refreshed user summary with Journey in one read model request", async () => {
    const { loadPortalReadModels } = await loadDataLoader();
    const currentUserSummary = {
      journeyLevelKey: "builder",
      mcpConnected: true,
      tokenApplied: true,
      updatedAt: "2026-08-20T09:30:00.000Z"
    };
    const result = await loadPortalReadModels(
      new AbortController().signal,
      ["journey"],
      async () => jsonResponse({
        me: { id: "user-1", status: currentUserSummary },
        journey: { level: { key: "builder" } }
      })
    );

    assert.deepEqual(result.currentUserSummary, currentUserSummary);
    assert.equal(result.currentUser.id, "user-1");
    assert.equal(result.patch.journey.level.key, "builder");
  });
});

async function loadSummaryCache() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-user-summary-cache-"));
  const outfile = join(outdir, "current-user-summary-cache.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./currentUserSummaryCache.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "node"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

function catalogWithSummary(summary) {
  return {
    currentUser: { id: "user-1", status: summary },
    journey: {
      badges: [],
      level: { key: summary.journeyLevelKey },
      updatedAt: summary.updatedAt
    }
  };
}

describe("current user summary cache", () => {
  it("hydrates the first Home render from a newer local user snapshot", async () => {
    const { hydratePortalCatalogCurrentUserSummary, writeCachedCurrentUserSummary } = await loadSummaryCache();
    const storage = memoryStorage();
    writeCachedCurrentUserSummary("user-1", {
      journeyLevelKey: "builder",
      mcpConnected: true,
      tokenApplied: true,
      updatedAt: "2026-08-20T09:30:00.000Z"
    }, storage, Date.parse("2026-08-20T09:30:01.000Z"));

    const hydrated = hydratePortalCatalogCurrentUserSummary(catalogWithSummary({
      journeyLevelKey: "newcomer",
      mcpConnected: false,
      tokenApplied: false,
      updatedAt: "2026-08-20T09:00:00.000Z"
    }), storage);

    assert.equal(hydrated.journey.level.key, "builder");
    assert.equal(hydrated.currentUser.status.mcpConnected, true);
    assert.equal(hydrated.currentUser.status.tokenApplied, true);
  });

  it("keeps a newer server snapshot and stores it for the next visit", async () => {
    const {
      hydratePortalCatalogCurrentUserSummary,
      readCachedCurrentUserSummary,
      writeCachedCurrentUserSummary
    } = await loadSummaryCache();
    const storage = memoryStorage();
    writeCachedCurrentUserSummary("user-1", {
      journeyLevelKey: "explorer",
      mcpConnected: false,
      tokenApplied: false,
      updatedAt: "2026-08-20T08:00:00.000Z"
    }, storage, Date.parse("2026-08-20T11:00:00.000Z"));

    const hydrated = hydratePortalCatalogCurrentUserSummary(catalogWithSummary({
      journeyLevelKey: "contributor",
      mcpConnected: true,
      tokenApplied: true,
      updatedAt: "2026-08-20T10:00:00.000Z"
    }), storage);

    assert.equal(hydrated.journey.level.key, "contributor");
    assert.equal(readCachedCurrentUserSummary("user-1", storage).summary.journeyLevelKey, "contributor");
  });

  it("applies refreshed summary and level in one immutable catalog update", async () => {
    const { mergePortalCurrentUserSummary } = await loadSummaryCache();
    const storage = memoryStorage();
    const initial = catalogWithSummary({
      journeyLevelKey: "explorer",
      mcpConnected: false,
      tokenApplied: false,
      updatedAt: "2026-08-20T08:00:00.000Z"
    });
    const refreshed = mergePortalCurrentUserSummary(initial, {
      journeyLevelKey: "builder",
      mcpConnected: true,
      tokenApplied: true,
      updatedAt: "2026-08-20T10:00:00.000Z"
    }, storage);

    assert.equal(initial.journey.level.key, "explorer");
    assert.equal(refreshed.journey.level.key, "builder");
    assert.deepEqual(refreshed.currentUser.status, {
      journeyLevelKey: "builder",
      mcpConnected: true,
      tokenApplied: true,
      updatedAt: "2026-08-20T10:00:00.000Z"
    });
  });
});
