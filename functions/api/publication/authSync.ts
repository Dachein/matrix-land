type PublicationAuthSyncEnv = {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
};

type PublicationAuthSyncDeps = {
  fetch?: typeof fetch;
};

export type PublicationPublicationStatus = "pending_review" | "listed" | "delisted" | "deleted";

export type PublicationPublicationProjection =
  | {
    endpointPath: "/v1/admin/apps" | "/v1/admin/resources";
    kind: "app" | "resource";
    payload: Record<string, unknown>;
    targetId: string;
  }
  | {
    endpointPath: "";
    kind: "none";
    payload: {
      reason: "app_not_found" | "workspace_auth_disabled" | "resource_not_required";
    };
    targetId: string;
  };

export type PublicationPublicationDeliveryResult =
  | {
    publicationStatus: "not_required";
    reason: "workspace_auth_disabled" | "resource_not_required";
    success: true;
  }
  | {
    publicationStatus: "synced";
    requestId: string;
    success: true;
  }
  | {
    errorCode:
      | "app_not_found"
      | "auth_worker_not_configured"
      | "auth_worker_rejected_projection"
      | "auth_worker_request_failed"
      | "invalid_auth_worker_url"
      | "invalid_publication_projection";
    httpStatus?: number;
    publicationStatus: "failed" | "pending";
    requestId: string;
    success: false;
  };

type AppAuthProjectionRow = {
  accessMode: string;
  accessTargetsJson: string;
  businessOwnerUserId: string | null;
  callbackUrl: string;
  id: string;
  launchUrl: string;
  name: string;
  publisherUserId: string | null;
  sdkStatus: string;
  status: string;
  usesWorkspaceAuth: boolean | number | string | null;
};

type ResourceListingRow = {
  accessTargetsJson?: string | null;
  createdByUserId: string | null;
  id: string;
  listingType: string;
  name: string;
  reviewVersionId: string;
  listedVersionId: string;
  status: string;
  targetId: string;
  visibility: string;
};

type PublicationVersionRow = {
  configJson: string;
  id: string;
  version: string;
};

export type PublicationAuthSyncResult =
  | {
    appId?: string;
    requestId?: string;
    reason: "app_not_found" | "auth_worker_not_configured" | "workspace_auth_disabled";
    skipped: true;
  }
  | {
    appId: string;
    status: string;
    synced: true;
  }
  | {
    appId?: string;
    errorCode: PublicationAuthSyncErrorCode;
    requestId?: string;
    status?: number;
    synced: false;
  };

export type PublicationResourceSyncResult =
  | {
    reason: "auth_worker_not_configured";
    resourceId?: string;
    skipped: true;
  }
  | {
    resourceId: string;
    status: string;
    synced: true;
  }
  | {
    errorCode: PublicationAuthSyncErrorCode;
    requestId?: string;
    resourceId?: string;
    status?: number;
    synced: false;
  };

type ProjectionSyncOptions = {
  requestId?: string;
  status?: string;
};

type PublicationAuthSyncErrorCode =
  | "auth_worker_rejected_projection"
  | "auth_worker_request_failed"
  | "invalid_auth_worker_url";

export async function buildPublicationPublicationProjection(
  db: D1Database,
  input: {
    builderSnapshot?: unknown;
    desiredStatus: PublicationPublicationStatus;
    createdByUserId?: string;
    listedVersionId?: string;
    listingId: string;
    listingName?: string;
    listingType: string;
    reviewVersionId?: string;
    targetId: string;
    targetPlane?: string;
    visibility?: string;
  }
): Promise<PublicationPublicationProjection> {
  if (input.listingType === "app") {
    const app = await readAppAuthProjection(db, input.targetId);
    if (!app) {
      const appsProjection = input.targetPlane === "apps"
        ? appsAppPublicationProjection(input)
        : undefined;
      if (appsProjection) {
        return appsProjection;
      }
      return {
        endpointPath: "",
        kind: "none",
        payload: { reason: "app_not_found" },
        targetId: input.targetId
      };
    }
    if (!isEnabledFlag(app.usesWorkspaceAuth)) {
      return {
        endpointPath: "",
        kind: "none",
        payload: { reason: "workspace_auth_disabled" },
        targetId: app.id
      };
    }
    return {
      endpointPath: "/v1/admin/apps",
      kind: "app",
      payload: authWorkerAppSnapshot(app, input.desiredStatus),
      targetId: app.id
    };
  }

  if (input.listingType === "skill") {
    const listing: ResourceListingRow = {
      accessTargetsJson: null,
      createdByUserId: input.createdByUserId ?? null,
      id: input.listingId,
      listingType: input.listingType,
      name: input.listingName ?? "",
      reviewVersionId: input.reviewVersionId ?? "",
      listedVersionId: input.desiredStatus === "listed"
        ? input.reviewVersionId ?? input.listedVersionId ?? ""
        : input.listedVersionId ?? "",
      status: input.desiredStatus,
      targetId: input.targetId,
      visibility: input.visibility ?? "org"
    };
    const version = await readPublicationVersion(db, listing);
    const payload = version
      ? resourceProjectionFromConfig(listing, version.configJson, input.desiredStatus)
      : undefined;
    if (!payload) {
      return {
        endpointPath: "",
        kind: "none",
        payload: { reason: "resource_not_required" },
        targetId: input.targetId
      };
    }
    return {
      endpointPath: "/v1/admin/resources",
      kind: "resource",
      payload,
      targetId: readOptionalString(payload.id) ?? input.targetId
    };
  }

  return {
    endpointPath: "",
    kind: "none",
    payload: { reason: "resource_not_required" },
    targetId: input.targetId
  };
}

export async function deliverPublicationPublicationProjection<TEnv extends PublicationAuthSyncEnv>(
  env: TEnv,
  projection: PublicationPublicationProjection,
  deps: PublicationAuthSyncDeps = {},
  requestedRequestId?: string
): Promise<PublicationPublicationDeliveryResult> {
  const requestId = syncRequestId(requestedRequestId);
  if (projection.kind === "none") {
    if (projection.payload.reason === "app_not_found") {
      return {
        errorCode: "app_not_found",
        publicationStatus: "failed",
        requestId,
        success: false
      };
    }
    return {
      publicationStatus: "not_required",
      reason: projection.payload.reason,
      success: true
    };
  }

  const baseUrl = env.AUTH_WORKER_URL?.trim();
  const serviceToken = env.AUTH_SERVICE_TOKEN?.trim();
  if (!baseUrl || !serviceToken) {
    return {
      errorCode: "auth_worker_not_configured",
      publicationStatus: "pending",
      requestId,
      success: false
    };
  }

  const endpoint = authWorkerEndpoint(baseUrl, projection.endpointPath);
  if (!endpoint) {
    return {
      errorCode: "invalid_auth_worker_url",
      publicationStatus: "failed",
      requestId,
      success: false
    };
  }

  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
      "x-request-id": requestId
    },
    body: JSON.stringify(projection.payload)
  }).catch(() => undefined);

  if (!response) {
    return {
      errorCode: "auth_worker_request_failed",
      publicationStatus: "failed",
      requestId,
      success: false
    };
  }

  if (!response.ok) {
    return {
      errorCode: "auth_worker_rejected_projection",
      httpStatus: response.status,
      publicationStatus: "failed",
      requestId: responseRequestIdForSync(response, requestId),
      success: false
    };
  }

  return {
    publicationStatus: "synced",
    requestId: responseRequestIdForSync(response, requestId),
    success: true
  };
}

export async function syncPublicationAppAuth<TEnv extends PublicationAuthSyncEnv>(
  db: D1Database,
  env: TEnv,
  appId: string,
  deps: PublicationAuthSyncDeps = {},
  options: ProjectionSyncOptions = {}
): Promise<PublicationAuthSyncResult> {
  const app = await readAppAuthProjection(db, appId);

  if (!app) {
    return { appId, skipped: true, reason: "app_not_found" };
  }

  const projectedStatus = readOptionalString(options.status) ?? app.status;

  if (!isEnabledFlag(app.usesWorkspaceAuth)) {
    return { appId, skipped: true, reason: "workspace_auth_disabled" };
  }

  const baseUrl = env.AUTH_WORKER_URL?.trim();
  const serviceToken = env.AUTH_SERVICE_TOKEN?.trim();

  if (!baseUrl || !serviceToken) {
    return { appId: app.id, skipped: true, reason: "auth_worker_not_configured" };
  }

  const endpoint = authWorkerEndpoint(baseUrl);
  const requestId = syncRequestId(options.requestId);
  if (!endpoint) {
    return {
      appId: app.id,
      synced: false,
      errorCode: "invalid_auth_worker_url",
      ...(requestId ? { requestId } : {})
    };
  }

  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
      ...(requestId ? { "x-request-id": requestId } : {})
    },
    body: JSON.stringify(authWorkerAppSnapshot(app, projectedStatus))
  }).catch(() => undefined);

  if (!response) {
    return {
      appId: app.id,
      synced: false,
      errorCode: "auth_worker_request_failed",
      ...(requestId ? { requestId } : {})
    };
  }

  if (!response.ok) {
    const responseRequestId = responseRequestIdForSync(response, requestId);
    return {
      appId: app.id,
      synced: false,
      errorCode: "auth_worker_rejected_projection",
      status: response.status,
      ...(responseRequestId ? { requestId: responseRequestId } : {})
    };
  }

  return { appId: app.id, status: projectedStatus, synced: true };
}

async function readAppAuthProjection(db: D1Database, appId: string) {
  return db
    .prepare(
      `
      SELECT
        id,
        name,
        status,
        sdk_status AS sdkStatus,
        launch_url AS launchUrl,
        callback_url AS callbackUrl,
        access_mode AS accessMode,
        access_targets_json AS accessTargetsJson,
        uses_workspace_auth AS usesWorkspaceAuth,
        publisher_user_id AS publisherUserId,
        business_owner_user_id AS businessOwnerUserId
      FROM apps
      WHERE id = ?
      LIMIT 1
      `
    )
    .bind(appId)
    .first<AppAuthProjectionRow>();
}

export async function syncPublicationResourceAuthForListing<TEnv extends PublicationAuthSyncEnv>(
  db: D1Database,
  env: TEnv,
  listingId: string,
  deps: PublicationAuthSyncDeps = {},
  options: ProjectionSyncOptions = {}
): Promise<PublicationResourceSyncResult | undefined> {
  const listing = await db
    .prepare(
      `
      SELECT
        id,
        listing_type AS listingType,
        target_id AS targetId,
        listed_version_id AS listedVersionId,
        review_version_id AS reviewVersionId,
        created_by_user_id AS createdByUserId,
        name,
        status,
        visibility
      FROM publication_listings
      WHERE id = ?
      LIMIT 1
      `
    )
    .bind(listingId)
    .first<ResourceListingRow>();

  return listing ? syncPublicationResourceAuth(db, env, listing, deps, options) : undefined;
}

export async function syncPublicationResourceAuthForTarget<TEnv extends PublicationAuthSyncEnv>(
  db: D1Database,
  env: TEnv,
  targetType: string,
  targetId: string,
  deps: PublicationAuthSyncDeps = {},
  options: ProjectionSyncOptions = {}
): Promise<PublicationResourceSyncResult | undefined> {
  const listing = await db
    .prepare(
      `
      SELECT
        id,
        listing_type AS listingType,
        target_id AS targetId,
        listed_version_id AS listedVersionId,
        review_version_id AS reviewVersionId,
        created_by_user_id AS createdByUserId,
        name,
        status,
        visibility
      FROM publication_listings
      WHERE listing_type = ? AND target_id = ?
      LIMIT 1
      `
    )
    .bind(targetType, targetId)
    .first<ResourceListingRow>();

  return listing ? syncPublicationResourceAuth(db, env, listing, deps, options) : undefined;
}

async function syncPublicationResourceAuth<TEnv extends PublicationAuthSyncEnv>(
  db: D1Database,
  env: TEnv,
  listing: ResourceListingRow,
  deps: PublicationAuthSyncDeps,
  options: ProjectionSyncOptions
): Promise<PublicationResourceSyncResult | undefined> {
  if (listing.listingType !== "skill") {
    return undefined;
  }

  const version = await readPublicationVersion(db, listing);
  if (!version) {
    return undefined;
  }

  const projection = resourceProjectionFromConfig(listing, version.configJson, options.status);
  if (!projection) {
    return undefined;
  }

  const baseUrl = env.AUTH_WORKER_URL?.trim();
  const serviceToken = env.AUTH_SERVICE_TOKEN?.trim();

  if (!baseUrl || !serviceToken) {
    return { resourceId: projection.id, skipped: true, reason: "auth_worker_not_configured" };
  }

  const endpoint = authWorkerEndpoint(baseUrl, "/v1/admin/resources");
  const requestId = syncRequestId(options.requestId);
  if (!endpoint) {
    return {
      resourceId: projection.id,
      synced: false,
      errorCode: "invalid_auth_worker_url",
      ...(requestId ? { requestId } : {})
    };
  }

  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
      ...(requestId ? { "x-request-id": requestId } : {})
    },
    body: JSON.stringify(projection)
  }).catch(() => undefined);

  if (!response) {
    return {
      resourceId: projection.id,
      synced: false,
      errorCode: "auth_worker_request_failed",
      ...(requestId ? { requestId } : {})
    };
  }

  if (!response.ok) {
    const responseRequestId = responseRequestIdForSync(response, requestId);
    return {
      resourceId: projection.id,
      synced: false,
      errorCode: "auth_worker_rejected_projection",
      status: response.status,
      ...(responseRequestId ? { requestId: responseRequestId } : {})
    };
  }

  return { resourceId: projection.id, status: projection.status, synced: true };
}

async function readPublicationVersion(db: D1Database, listing: ResourceListingRow) {
  const pinnedVersion = readOptionalString(listing.listedVersionId) ?? readOptionalString(listing.reviewVersionId);

  if (pinnedVersion) {
    const version = await db
      .prepare(
        `
        SELECT id, version, config_json AS configJson
        FROM publication_versions
        WHERE listing_id = ?
          AND (id = ? OR version = ?)
        ORDER BY created_at DESC
        LIMIT 1
        `
      )
      .bind(listing.id, pinnedVersion, pinnedVersion)
      .first<PublicationVersionRow>();

    if (version) {
      return version;
    }
  }

  return db
    .prepare(
      `
      SELECT id, version, config_json AS configJson
      FROM publication_versions
      WHERE listing_id = ?
      ORDER BY created_at DESC
      LIMIT 1
      `
    )
    .bind(listing.id)
    .first<PublicationVersionRow>();
}

function resourceProjectionFromConfig(listing: ResourceListingRow, configJson: string, statusOverride?: string) {
  const config = readJsonObject(configJson);
  const resourceApi = readObject(config.resourceApi ?? config.resource_api ?? config.mcpBroker ?? config.mcp_broker);
  const tools = readArray(resourceApi.tools ?? config.tools);

  if (Object.keys(resourceApi).length === 0 || tools.length === 0) {
    return undefined;
  }

  const baseUrl = readOptionalString(resourceApi.baseUrl ?? resourceApi.base_url ?? resourceApi.resourceUrl ?? resourceApi.resource_url);
  const resourceId = readOptionalString(resourceApi.id ?? resourceApi.resourceId ?? resourceApi.resource_id) ?? listing.id;
  const audience = readOptionalString(resourceApi.audience) ?? baseUrl ?? resourceId;
  const allowedScopes = Array.from(new Set([
    ...readStringArray(resourceApi.allowedScopes ?? resourceApi.allowed_scopes ?? resourceApi.scopes),
    ...tools.flatMap((tool) => {
      const item = readObject(tool);
      return readStringArray(item.requiredScopes ?? item.required_scopes ?? item.scopes);
    })
  ]));

  return {
    accessMode: readAccessMode(resourceApi.accessMode ?? resourceApi.access_mode ?? config.accessMode ?? config.access_mode),
    accessTargets: readStringArray(resourceApi.accessTargets ?? resourceApi.access_targets ?? config.accessTargets ?? config.access_targets),
    allowedScopes,
    audience,
    businessOwnerUserId: readOptionalString(resourceApi.businessOwnerUserId ?? resourceApi.business_owner_user_id),
    id: resourceId,
    name: readOptionalString(resourceApi.name) ?? listing.name,
    publisherUserId: readOptionalString(resourceApi.publisherUserId ?? resourceApi.publisher_user_id) ?? readOptionalString(listing.createdByUserId),
    status: readOptionalString(statusOverride) ?? listing.status
  };
}

function authWorkerAppSnapshot(app: AppAuthProjectionRow, status: string) {
  return {
    accessMode: app.accessMode,
    accessTargets: readStringArrayJson(app.accessTargetsJson),
    businessOwnerUserId: app.businessOwnerUserId ?? undefined,
    callbackUrls: [app.callbackUrl].filter(Boolean),
    id: app.id,
    launchUrl: app.launchUrl,
    name: app.name,
    publisherUserId: app.publisherUserId ?? undefined,
    sdkStatus: app.sdkStatus,
    status
  };
}

function appsAppPublicationProjection(input: {
  builderSnapshot?: unknown;
  createdByUserId?: string;
  desiredStatus: PublicationPublicationStatus;
  listingName?: string;
  targetId: string;
}): PublicationPublicationProjection | undefined {
  const snapshot = typeof input.builderSnapshot === "string"
    ? readJsonObject(input.builderSnapshot)
    : readObject(input.builderSnapshot);
  const appsVerified = readObject(snapshot.appsVerified);
  const app = readObject(appsVerified.app);
  if (readOptionalString(app.id) !== input.targetId) {
    return undefined;
  }

  if (app.loginRequired !== true) {
    return {
      endpointPath: "",
      kind: "none",
      payload: { reason: "workspace_auth_disabled" },
      targetId: input.targetId
    };
  }

  const manifest = readObject(app.manifest ?? appsVerified.manifest);
  const auth = readObject(manifest.auth);
  const runtime = readObject(manifest.runtime);
  const callbackUrls = readObject(auth.callbackUrls);
  const productionUrl = readOptionalString(app.productionUrl)
    ?? readOptionalString(runtime.productionUrl);
  if (!productionUrl) {
    return undefined;
  }

  const configuredAccessTargets = readStringArray(app.accessTargets);
  const collaboratorAccessTargets = readStringArray(app.collaboratorUserIds)
    .map((userId) => `user:${userId}`);
  const accessTargets = Array.from(new Set([
    ...collaboratorAccessTargets,
    ...configuredAccessTargets
  ])).slice(0, 400);
  const visibility = readString(app.visibility).trim();
  const ownerUserId = readOptionalString(app.ownerUserId)
    ?? readOptionalString(input.createdByUserId);
  const callbackUrl = readOptionalString(callbackUrls.production)
    ?? readOptionalString(callbackUrls.fallbackProduction)
    ?? `${productionUrl.replace(/\/+$/, "")}/auth/workspace/callback`;

  return {
    endpointPath: "/v1/admin/apps",
    kind: "app",
    payload: {
      accessMode: configuredAccessTargets.length > 0 || visibility === "private" || visibility === "team"
        ? "targeted"
        : "public",
      accessTargets,
      businessOwnerUserId: ownerUserId,
      callbackUrls: [callbackUrl],
      id: input.targetId,
      launchUrl: productionUrl,
      name: readOptionalString(input.listingName) ?? readOptionalString(app.name) ?? input.targetId,
      publisherUserId: ownerUserId,
      sdkStatus: "connected",
      status: input.desiredStatus
    },
    targetId: input.targetId
  };
}

function authWorkerEndpoint(baseUrl: string, path = "/v1/admin/apps") {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    return `${url.toString().replace(/\/+$/, "")}${path}`;
  } catch {
    return undefined;
  }
}

function syncRequestId(value: unknown) {
  const requestId = readString(value).trim();
  if (/^[A-Za-z0-9._:/-]{1,128}$/.test(requestId)) {
    return requestId;
  }
  return crypto.randomUUID();
}

function responseRequestIdForSync(response: Response, fallback: string) {
  const upstreamRequestId = readString(response.headers.get("x-request-id")).trim();
  return /^[A-Za-z0-9._:/-]{1,128}$/.test(upstreamRequestId) ? upstreamRequestId : fallback;
}

function isEnabledFlag(value: AppAuthProjectionRow["usesWorkspaceAuth"]) {
  return value === true || value === 1 || value === "1";
}

function readAccessMode(value: unknown) {
  const mode = readString(value).trim();
  return mode === "request" || mode === "targeted" ? mode : "public";
}

function readJsonObject(value: unknown) {
  try {
    return readObject(JSON.parse(readString(value)));
  } catch {
    return {};
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => readString(item).trim()).filter(Boolean);
  }

  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((item) => readString(item).trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function readStringArrayJson(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item).trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}
