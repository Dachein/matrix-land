import type {
  ForumDiscussionPage,
  ForumDiscussionQuery,
  PortalCatalog
} from "../../../../src/shared/types";
import type { PortalCurrentUserStatus } from "../../../../src/shared/types";
import { hydratePortalCatalogCurrentUserSummary } from "./currentUserSummaryCache";
import { recordPortalLoadTiming } from "./portalLoadMetrics";

export type AuthSession = {
  authenticated: boolean;
  configured: boolean;
  emailLoginConfigured: boolean;
  entraLoginConfigured?: boolean;
  emailLoginUrl: string;
  loginUrl: string;
  logoutUrl: string;
};

export type PortalReadModel = "activity" | "apps" | "discussions" | "hub" | "journey" | "publication" | "reviewPublication" | "skills";

export type PortalLoadError = {
  scope: "auth" | "catalog";
  status?: number;
};

export type PortalDataLoadResult = {
  auth?: AuthSession;
  catalog?: PortalCatalog;
  degradedResources: PortalReadModel[];
  error?: PortalLoadError;
  forumPage?: ForumDiscussionPage;
};

export type PortalReadModelLoadResult = {
  currentUser?: PortalCatalog["currentUser"];
  currentUserSummary?: PortalCurrentUserStatus;
  degradedResources: PortalReadModel[];
  forumPage?: ForumDiscussionPage;
  patch: ReadModelPatch;
  unauthorized: boolean;
};

type ReadModelPatch = Partial<Pick<
  PortalCatalog,
  "activityEvents" | "apps" | "discussions" | "hubListings" | "journey" | "publicationListings" | "skills"
>>;

type ReadModelResult = {
  currentUser?: PortalCatalog["currentUser"];
  currentUserSummary?: PortalCurrentUserStatus;
  forumPage?: ForumDiscussionPage;
  patch: ReadModelPatch;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type PortalDataLoadOptions = { authOnly?: boolean; bootstrapTimeoutMs?: number };

type InitialPortalDataRequest = {
  authOnly: boolean;
  controller: AbortController;
  routeRequests: Array<{ resource: PortalReadModel; promise: Promise<PortalReadModelLoadResult> }>;
  routePromise?: Promise<PortalReadModelLoadResult>;
  routeResources: PortalReadModel[];
  promise: Promise<PortalDataLoadResult>;
};

let initialPortalDataRequest: InitialPortalDataRequest | undefined;
const READ_MODEL_TIMEOUT_MS = 8_000;
const PUBLICATION_READ_TIMEOUT_MS = 30_000;
const BOOTSTRAP_TIMEOUT_MS = 12_000;

const readModels: Array<{
  field: keyof ReadModelPatch;
  name: PortalReadModel;
  path: string;
  shape: "array" | "object";
  timeoutMs?: number;
}> = [
  { field: "apps", name: "apps", path: "/api/apps", shape: "array" },
  { field: "skills", name: "skills", path: "/api/skills", shape: "array" },
  { field: "publicationListings", name: "publication", path: "/api/publication/listings", shape: "array", timeoutMs: PUBLICATION_READ_TIMEOUT_MS },
  { field: "publicationListings", name: "reviewPublication", path: "/api/publication/listings?view=review", shape: "array", timeoutMs: PUBLICATION_READ_TIMEOUT_MS },
  { field: "hubListings", name: "hub", path: "/api/publication/hub-listings", shape: "array", timeoutMs: PUBLICATION_READ_TIMEOUT_MS },
  { field: "discussions", name: "discussions", path: "/api/forum/topics", shape: "array" },
  { field: "activityEvents", name: "activity", path: "/api/activity/events?scenario=community&limit=10", shape: "array" },
  { field: "journey", name: "journey", path: "/api/me", shape: "object" }
];

export async function loadPortalData(
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
  options: PortalDataLoadOptions = {}
): Promise<PortalDataLoadResult> {
  const startedAt = globalThis.performance?.now?.();
  try {
    return await loadPortalDataRequest(signal, fetchImpl, options);
  } finally {
    recordPortalLoadTiming("bootstrap", startedAt);
  }
}

async function loadPortalDataRequest(
  signal: AbortSignal,
  fetchImpl: FetchLike,
  options: PortalDataLoadOptions
): Promise<PortalDataLoadResult> {
  if (options.authOnly) {
    try {
      return {
        auth: await readAuthSession(signal, fetchImpl, options.bootstrapTimeoutMs),
        degradedResources: []
      };
    } catch (error) {
      return {
        degradedResources: [],
        error: { scope: "auth", status: responseStatus(error) }
      };
    }
  }

  try {
    const bootstrap = await readHomeBootstrap(signal, fetchImpl, options.bootstrapTimeoutMs);
    const auth = requireAuthSession(bootstrap.auth);

    if (auth.configured && !auth.authenticated) {
      return { auth, degradedResources: [] };
    }

    const catalog = portalCatalogWithBootstrapMe(
      requirePortalCatalog(bootstrap.catalog),
      bootstrap.me
    );
    return {
      auth,
      catalog: hydratePortalCatalogCurrentUserSummary(catalog),
      degradedResources: []
    };
  } catch (error) {
    if (error instanceof ApiResponseError && error.status === 404) {
      return loadPortalDataLegacy(signal, fetchImpl, options.bootstrapTimeoutMs);
    }

    return {
      degradedResources: [],
      error: { scope: "catalog", status: responseStatus(error) }
    };
  }
}

/** Starts the initial read before the locale bundle has finished loading. */
export function preloadInitialPortalData(authOnly: boolean, routeResources: PortalReadModel[] = []) {
  initialPortalDataRequest?.controller.abort();
  const controller = new AbortController();
  const selectedRouteResources = authOnly ? [] : uniqueReadModels(routeResources);
  const routeRequests = selectedRouteResources.map((resource) => ({
    resource,
    promise: loadPortalReadModels(controller.signal, [resource], fetch)
  }));
  initialPortalDataRequest = {
    authOnly,
    controller,
    routeRequests,
    routePromise: routeRequests.length
      ? Promise.all(routeRequests.map(({ promise }) => promise)).then(mergeReadModelResults)
      : undefined,
    routeResources: selectedRouteResources,
    promise: loadPortalData(controller.signal, fetch, { authOnly })
  };
}

/** Reuses the startup request from usePortalData; route mode must still match. */
export function consumeInitialPortalData(authOnly: boolean) {
  const request = initialPortalDataRequest;
  if (!request) {
    return undefined;
  }

  if (request.authOnly !== authOnly) {
    request.controller.abort();
    initialPortalDataRequest = undefined;
    return undefined;
  }

  return request;
}

export function clearInitialPortalData(request: InitialPortalDataRequest | undefined) {
  if (request && initialPortalDataRequest === request) {
    initialPortalDataRequest = undefined;
  }
}

export async function loadPortalHomeApplications(
  signal: AbortSignal,
  targetIds: string[],
  fetchImpl: FetchLike = fetch,
  options: { timeoutMs?: number } = {}
) {
  return loadHomeApplicationReadModels(signal, uniqueTargetIds(targetIds), fetchImpl, options.timeoutMs);
}

export async function loadPortalApps(
  signal: AbortSignal,
  targetIds: string[],
  fetchImpl: FetchLike = fetch
): Promise<PortalCatalog["apps"]> {
  const ids = uniqueTargetIds(targetIds);
  const apps = await Promise.all(ids.map(async (id) => {
    const payload = await fetchJson<Record<string, unknown>>(
      `/api/apps/${encodeURIComponent(id)}`,
      signal,
      fetchImpl
    );
    if (!isRecord(payload.app)) {
      throw new ApiResponseError(502);
    }
    return payload.app as PortalCatalog["apps"][number];
  }));

  return apps;
}

export async function loadPortalReadModels(
  signal: AbortSignal,
  resources: PortalReadModel[],
  fetchImpl: FetchLike = fetch,
  options: { timeoutMs?: number } = {}
): Promise<PortalReadModelLoadResult> {
  const selectedModels = uniqueReadModels(resources)
    .map((resource) => readModels.find((model) => model.name === resource))
    .filter((model): model is (typeof readModels)[number] => Boolean(model));
  const settled = await Promise.allSettled(selectedModels.map(async (model) => ({
    model,
    result: await readModelWithDeadline(model, signal, fetchImpl, options.timeoutMs ?? model.timeoutMs ?? READ_MODEL_TIMEOUT_MS)
  })));
  const degradedResources: PortalReadModel[] = [];
  let forumPage: ForumDiscussionPage | undefined;
  let currentUser: PortalCatalog["currentUser"] | undefined;
  let currentUserSummary: PortalCurrentUserStatus | undefined;
  let patch: ReadModelPatch = {};
  let unauthorized = false;

  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    const model = selectedModels[index];

    if (result.status === "fulfilled") {
      patch = { ...patch, ...result.value.result.patch };
      currentUser = result.value.result.currentUser ?? currentUser;
      currentUserSummary = result.value.result.currentUserSummary ?? currentUserSummary;
      forumPage = result.value.result.forumPage ?? forumPage;
      continue;
    }

    if (isUnauthorized(result.reason)) {
      unauthorized = true;
      continue;
    }

    degradedResources.push(model.name);
  }

  return { currentUser, currentUserSummary, degradedResources, forumPage, patch, unauthorized };
}

async function readModelWithDeadline(
  model: (typeof readModels)[number],
  signal: AbortSignal,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<ReadModelResult> {
  const startedAt = globalThis.performance?.now?.();
  try {
    return await withRequestDeadline(signal, timeoutMs, (requestSignal) => (
      readModel(model, requestSignal, fetchImpl)
    ));
  } finally {
    recordPortalLoadTiming(`read-model:${model.name}`, startedAt);
  }
}

async function withRequestDeadline<T>(
  signal: AbortSignal,
  timeoutMs: number,
  load: (requestSignal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      load(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("request_timeout"));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function mergeReadModelResults(results: PortalReadModelLoadResult[]): PortalReadModelLoadResult {
  return results.reduce<PortalReadModelLoadResult>((combined, result) => ({
    currentUser: result.currentUser ?? combined.currentUser,
    currentUserSummary: result.currentUserSummary ?? combined.currentUserSummary,
    degradedResources: [...combined.degradedResources, ...result.degradedResources],
    forumPage: result.forumPage ?? combined.forumPage,
    patch: { ...combined.patch, ...result.patch },
    unauthorized: combined.unauthorized || result.unauthorized
  }), { degradedResources: [], patch: {}, unauthorized: false });
}

export async function loadPortalDiscussions(
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<PortalCatalog["discussions"]> {
  const page = await loadPortalDiscussionPage(signal, {}, fetchImpl);
  return mergeForumDiscussionPage(page);
}

export async function loadPortalDiscussionPage(
  signal: AbortSignal,
  query: ForumDiscussionQuery = {},
  fetchImpl: FetchLike = fetch
): Promise<ForumDiscussionPage> {
  const payload = await fetchJson<Record<string, unknown>>(
    forumDiscussionPagePath(query),
    signal,
    fetchImpl,
    "no-store"
  );
  if (!Array.isArray(payload.discussions) || !Array.isArray(payload.pinnedDiscussions)) {
    throw new ApiResponseError(502);
  }
  if (payload.nextCursor !== undefined && typeof payload.nextCursor !== "string") {
    throw new ApiResponseError(502);
  }
  return {
    discussions: payload.discussions as ForumDiscussionPage["discussions"],
    pinnedDiscussions: payload.pinnedDiscussions as ForumDiscussionPage["pinnedDiscussions"],
    ...(typeof payload.nextCursor === "string" && payload.nextCursor ? { nextCursor: payload.nextCursor } : {})
  };
}

async function readAuthSession(signal: AbortSignal, fetchImpl: FetchLike, timeoutMs = BOOTSTRAP_TIMEOUT_MS): Promise<AuthSession> {
  return requireAuthSession(await withRequestDeadline(signal, timeoutMs, (requestSignal) => (
    fetchJson<unknown>("/api/auth/session", requestSignal, fetchImpl)
  )));
}

async function readHomeBootstrap(signal: AbortSignal, fetchImpl: FetchLike, timeoutMs = BOOTSTRAP_TIMEOUT_MS) {
  const payload = await withRequestDeadline(signal, timeoutMs, (requestSignal) => (
    fetchJson<unknown>("/api/home-bootstrap", requestSignal, fetchImpl)
  ));
  if (!isRecord(payload) || !("auth" in payload)) {
    throw new ApiResponseError(502);
  }

  return payload;
}

async function loadPortalDataLegacy(
  signal: AbortSignal,
  fetchImpl: FetchLike,
  timeoutMs = BOOTSTRAP_TIMEOUT_MS
): Promise<PortalDataLoadResult> {
  let auth: AuthSession;

  try {
    auth = await readAuthSession(signal, fetchImpl, timeoutMs);
  } catch (error) {
    return {
      degradedResources: [],
      error: { scope: "auth", status: responseStatus(error) }
    };
  }

  if (auth.configured && !auth.authenticated) {
    return { auth, degradedResources: [] };
  }

  try {
    return {
      auth,
      catalog: hydratePortalCatalogCurrentUserSummary(requirePortalCatalog(await withRequestDeadline(
        signal,
        timeoutMs,
        (requestSignal) => fetchJson<unknown>("/api/catalog", requestSignal, fetchImpl)
      ))),
      degradedResources: []
    };
  } catch (error) {
    if (isUnauthorized(error)) {
      return {
        auth: { ...auth, authenticated: false, configured: true },
        degradedResources: []
      };
    }

    return {
      auth,
      degradedResources: [],
      error: { scope: "catalog", status: responseStatus(error) }
    };
  }
}

function requireAuthSession(value: unknown): AuthSession {
  if (!isRecord(value)) {
    throw new ApiResponseError(502);
  }

  return {
    authenticated: value.authenticated === true,
    configured: value.configured === true,
    emailLoginConfigured: value.emailLoginConfigured === true,
    entraLoginConfigured: typeof value.entraLoginConfigured === "boolean" ? value.entraLoginConfigured : value.configured === true,
    emailLoginUrl: typeof value.emailLoginUrl === "string" ? value.emailLoginUrl : "/auth/email/login",
    loginUrl: typeof value.loginUrl === "string" ? value.loginUrl : "/auth/login",
    logoutUrl: typeof value.logoutUrl === "string" ? value.logoutUrl : "/auth/logout"
  };
}

async function readModel(
  model: (typeof readModels)[number],
  signal: AbortSignal,
  fetchImpl: FetchLike
): Promise<ReadModelResult> {
  if (model.name === "discussions") {
    const forumPage = await loadPortalDiscussionPage(signal, {}, fetchImpl);
    return {
      forumPage,
      patch: { discussions: mergeForumDiscussionPage(forumPage) }
    };
  }

  const payload = await fetchJson<Record<string, unknown>>(model.path, signal, fetchImpl);
  const payloadKey = model.field === "activityEvents" ? "events" : model.field;
  const value = payload[payloadKey];
  const isExpectedShape = model.shape === "array" ? Array.isArray(value) : isRecord(value);

  if (!isExpectedShape) {
    throw new ApiResponseError(502);
  }

  return {
    ...(model.name === "journey" && isPortalCurrentUser(payload.me)
      ? {
          currentUser: payload.me,
          ...(isCurrentUserSummary(payload.me.status) ? { currentUserSummary: payload.me.status } : {})
        }
      : {}),
    patch: { [model.field]: value } as ReadModelPatch
  };
}

async function loadHomeApplicationReadModels(
  signal: AbortSignal,
  targetIds: string[],
  fetchImpl: FetchLike,
  timeoutMs?: number
): Promise<PortalReadModelLoadResult> {
  const encodedIds = targetIds.length > 0 ? encodeURIComponent(targetIds.join(",")) : "";
  const appsPath = encodedIds ? `/api/apps?ids=${encodedIds}` : "/api/apps";
  const hubListingsPath = encodedIds
    ? `/api/publication/hub-listings?ids=${encodedIds}&type=app`
    : "/api/publication/hub-listings?type=app";
  const settled = await Promise.allSettled([
    withRequestDeadline(signal, timeoutMs ?? READ_MODEL_TIMEOUT_MS, (requestSignal) => (
      fetchJson<Record<string, unknown>>(appsPath, requestSignal, fetchImpl)
    )),
    withRequestDeadline(signal, timeoutMs ?? PUBLICATION_READ_TIMEOUT_MS, (requestSignal) => (
      fetchJson<Record<string, unknown>>(hubListingsPath, requestSignal, fetchImpl)
    ))
  ]);
  const degradedResources: PortalReadModel[] = [];
  const patch: ReadModelPatch = {};
  let unauthorized = false;
  const fields = ["apps", "hubListings"] as const;
  const resources: PortalReadModel[] = ["apps", "hub"];

  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      if (isUnauthorized(result.reason)) {
        unauthorized = true;
      } else {
        degradedResources.push(resources[index]);
      }
      return;
    }

    const field = fields[index];
    const value = result.value[field];
    if (!Array.isArray(value)) {
      degradedResources.push(resources[index]);
      return;
    }
    Object.assign(patch, { [field]: value });
  });

  return { degradedResources, patch, unauthorized };
}

function mergeForumDiscussionPage(page: ForumDiscussionPage) {
  return [...page.pinnedDiscussions, ...page.discussions];
}

function forumDiscussionPagePath(query: ForumDiscussionQuery) {
  const searchParams = new URLSearchParams();
  if (query.category?.trim()) searchParams.set("category", query.category.trim());
  if (query.cursor?.trim()) searchParams.set("cursor", query.cursor.trim());
  if (Number.isFinite(query.limit)) searchParams.set("limit", String(Math.floor(Number(query.limit))));
  if (query.owner === "mine") searchParams.set("owner", "mine");
  if (query.query?.trim()) searchParams.set("q", query.query.trim());
  const queryString = searchParams.toString();
  return `/api/forum/topics${queryString ? `?${queryString}` : ""}`;
}

async function fetchJson<T>(
  path: string,
  signal: AbortSignal,
  fetchImpl: FetchLike,
  cache?: RequestCache
): Promise<T> {
  const response = await fetchImpl(path, {
    ...(cache ? { cache } : {}),
    headers: { Accept: "application/json" },
    signal
  });

  if (!response.ok) {
    throw new ApiResponseError(response.status);
  }

  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new ApiResponseError(502);
  }

  return response.json() as Promise<T>;
}

function requirePortalCatalog(value: unknown): PortalCatalog {
  if (!isRecord(value) || !isRecord(value.portal) || !isRecord(value.currentUser)) {
    throw new ApiResponseError(502);
  }

  const arrayFields: Array<keyof PortalCatalog> = [
    "activityEvents",
    "apps",
    "audit",
    "categories",
    "dataServices",
    "discussions",
    "hubListings",
    "publicationListings",
    "mcpTools",
    "reviewQueue",
    "skills"
  ];

  if (arrayFields.some((field) => !Array.isArray(value[field]))) {
    throw new ApiResponseError(502);
  }

  if (!isRecord(value.usage) || !isRecord(value.journey)) {
    throw new ApiResponseError(502);
  }

  return value as PortalCatalog;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPortalCurrentUser(value: unknown): value is PortalCatalog["currentUser"] {
  return isRecord(value) && typeof value.id === "string" && value.id.trim().length > 0;
}

function portalCatalogWithBootstrapMe(catalog: PortalCatalog, value: unknown): PortalCatalog {
  if (!isPortalCurrentUser(value) || value.id !== catalog.currentUser.id) {
    return catalog;
  }

  return {
    ...catalog,
    currentUser: {
      ...catalog.currentUser,
      ...value,
      identity: catalog.currentUser.identity
    }
  };
}

function isCurrentUserSummary(value: unknown): value is PortalCurrentUserStatus {
  return isRecord(value)
    && typeof value.journeyLevelKey === "string"
    && typeof value.mcpConnected === "boolean"
    && typeof value.tokenApplied === "boolean";
}

function isUnauthorized(error: unknown) {
  return error instanceof ApiResponseError && error.status === 401;
}

function responseStatus(error: unknown) {
  return error instanceof ApiResponseError ? error.status : undefined;
}

function uniqueReadModels(resources: PortalReadModel[]) {
  return Array.from(new Set(resources));
}

function uniqueTargetIds(targetIds: string[]) {
  return Array.from(new Set(targetIds.map((targetId) => targetId.trim()).filter(Boolean))).slice(0, 24);
}

export class ApiResponseError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`api_response_${status}`);
    this.status = status;
  }
}
