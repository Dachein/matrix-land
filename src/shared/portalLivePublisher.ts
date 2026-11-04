export type PortalLiveEventLookup =
  | { activityEventId: string }
  | { notificationId: string };

export type PortalLivePublisherEnv = {
  PLATFORM_BRAND_JSON?: string;
  LIVE_PUBLISH_TOKEN?: string;
  LIVE_WORKER_URL?: string;
  PORTAL_LIVE_WORKSPACE_ID?: string;
};

export type PortalLiveDeferredContext<TEnv extends PortalLivePublisherEnv> = {
  env: TEnv;
  request?: Request;
  waitUntil?(promise: Promise<unknown>): void;
};

type PortalLivePublisherDeps = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_PUBLISH_TIMEOUT_MS = 4_000;

export function schedulePortalLiveEvent<TEnv extends PortalLivePublisherEnv>(
  context: PortalLiveDeferredContext<TEnv>,
  lookup: PortalLiveEventLookup,
  deps: PortalLivePublisherDeps = {}
) {
  if (!publisherIsConfigured(context.env) || !validLookup(lookup)) {
    return false;
  }

  const task = publishPortalLiveEvent(context.env, lookup, {
    ...deps,
    requestId: context.request?.headers.get("x-request-id") ?? undefined
  }).catch((error) => {
    console.warn("portal_live_publish_failed", {
      errorName: error instanceof Error ? error.name : typeof error,
      eventKind: "activityEventId" in lookup ? "activity" : "notification"
    });
  });

  if (typeof context.waitUntil === "function") {
    context.waitUntil(task);
  } else {
    void task;
  }
  return true;
}

export async function publishPortalLiveEvent(
  env: PortalLivePublisherEnv,
  lookup: PortalLiveEventLookup,
  deps: PortalLivePublisherDeps & { requestId?: string } = {}
) {
  const token = env.LIVE_PUBLISH_TOKEN?.trim();
  if (!publisherIsConfigured(env) || !validLookup(lookup)) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    normalizeTimeout(deps.timeoutMs)
  );

  try {
    const response = await (deps.fetch ?? fetch)(publishUrl(env), {
      body: JSON.stringify({
        ...lookup,
        workspaceId: env.PORTAL_LIVE_WORKSPACE_ID!.trim()
      }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(deps.requestId ? { "x-request-id": deps.requestId } : {})
      },
      method: "POST",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`portal_live_publish_http_${response.status}`);
    }
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

function publisherIsConfigured(env: PortalLivePublisherEnv) {
  return Boolean(env.LIVE_PUBLISH_TOKEN?.trim() && env.LIVE_WORKER_URL?.trim() && env.PORTAL_LIVE_WORKSPACE_ID?.trim());
}

function publishUrl(env: PortalLivePublisherEnv) {
  const baseUrl = env.LIVE_WORKER_URL!.trim();
  return `${baseUrl.replace(/\/+$/, "")}/v1/events`;
}

function normalizeTimeout(value: number | undefined) {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.min(15_000, Math.max(100, Math.floor(Number(value))))
    : DEFAULT_PUBLISH_TIMEOUT_MS;
}

function validLookup(lookup: PortalLiveEventLookup) {
  return "activityEventId" in lookup
    ? Boolean(lookup.activityEventId.trim())
    : Boolean(lookup.notificationId.trim());
}
